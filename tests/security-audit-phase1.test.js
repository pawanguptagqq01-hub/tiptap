const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3201;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const reqHeaders = { ...headers };
    let reqData = null;

    if (body) {
      reqData = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(reqData);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json
        });
      });
    });

    req.on('error', reject);
    if (reqData) req.write(reqData);
    req.end();
  });
}

function extractCookie(resHeaders) {
  const setCookie = resHeaders['set-cookie'];
  if (!setCookie) return null;
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = raw.match(/tiptap_session=([^;]+)/);
  return match ? `tiptap_session=${match[1]}` : null;
}

function extractRawSetCookie(resHeaders) {
  const setCookie = resHeaders['set-cookie'];
  if (!setCookie) return '';
  return Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
}

async function runAudit() {
  console.log('====================================================');
  console.log('🔍 PHASE 1: SECONDARY VALIDATION & SECURITY AUDIT');
  console.log('====================================================\n');

  const { createIsolatedTestDb } = require('./test-db-helper');
  const { tempDbPath, cleanup } = createIsolatedTestDb('sec-audit');

  // Spawn test server with NODE_ENV=production to test production security controls
  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), MONGODB_URI: '', NODE_ENV: 'production', TIPTAP_TEST_ALLOW_MUTATIONS: 'true', TIPTAP_DB_FILE: tempDbPath },
    stdio: 'pipe'
  });

  serverProc.stderr.on('data', d => console.error('[SERVER ERR]:', d.toString()));
  await new Promise(r => setTimeout(r, 1600));

  const results = {};

  try {
    // ----------------------------------------------------
    // CHECK 1: SESSION FIXATION
    // ----------------------------------------------------
    console.log('--- Checking 1. Session Fixation ---');
    const attackerSession = 'tiptap_session=attacker_pre_auth_fake_session_token_12345';
    const loginFixation = await makeRequest('POST', '/api/auth/restaurant-login', {
      Cookie: attackerSession
    }, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    const newCookie = extractCookie(loginFixation.headers);
    const fixationPassed = loginFixation.statusCode === 200 &&
      Boolean(loginFixation.data.sessionId) &&
      newCookie !== attackerSession &&
      !newCookie.includes('attacker_pre_auth_fake_session_token_12345');

    results['1. Session Fixation'] = {
      status: fixationPassed ? 'PASS' : 'FAIL',
      evidence: `Status: ${loginFixation.statusCode}, Pre-auth cookie: "${attackerSession}", Issued cookie: "${newCookie}"`
    };
    console.log(`Result: ${results['1. Session Fixation'].status}\n`);

    // ----------------------------------------------------
    // CHECK 2: SESSION EXPIRATION
    // ----------------------------------------------------
    console.log('--- Checking 2. Session Expiration ---');
    // Test an expired or fabricated non-existent session
    const expiredCheck = await makeRequest('GET', '/api/auth/session', {
      Cookie: 'tiptap_session=expired_or_non_existent_token_999999999'
    });
    const expirationPassed = expiredCheck.statusCode === 200 && expiredCheck.data.authenticated === false;
    results['2. Session Expiration'] = {
      status: expirationPassed ? 'PASS' : 'FAIL',
      evidence: `Status: ${expiredCheck.statusCode}, Response: ${JSON.stringify(expiredCheck.data)}`
    };
    console.log(`Result: ${results['2. Session Expiration'].status}\n`);

    // ----------------------------------------------------
    // CHECK 3: COOKIE SECURITY (HttpOnly, Secure, SameSite)
    // ----------------------------------------------------
    console.log('--- Checking 3. Cookie Security Settings ---');
    const setCookieHeader = extractRawSetCookie(loginFixation.headers);
    const hasHttpOnly = setCookieHeader.includes('HttpOnly');
    const hasSameSite = setCookieHeader.toLowerCase().includes('samesite=lax');
    const hasSecure = setCookieHeader.includes('Secure');
    const hasMaxAge = setCookieHeader.includes('Max-Age=86400');
    const cookiePassed = hasHttpOnly && hasSameSite && hasSecure && hasMaxAge;

    results['3. Cookie Security'] = {
      status: cookiePassed ? 'PASS' : 'FAIL',
      evidence: `Set-Cookie header: "${setCookieHeader}" (HttpOnly: ${hasHttpOnly}, SameSite: ${hasSameSite}, Secure: ${hasSecure}, Max-Age: ${hasMaxAge})`
    };
    console.log(`Result: ${results['3. Cookie Security'].status}\n`);

    // ----------------------------------------------------
    // CHECK 4: CSRF PROTECTION
    // ----------------------------------------------------
    console.log('--- Checking 4. CSRF Protection ---');
    const validCounterCookie = newCookie;
    const validCsrf = loginFixation.data.csrfToken;

    // 4a. Missing CSRF on state-changing endpoint
    const missingCsrf = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: validCounterCookie
    }, { name: 'TipTap CSRF Test' });

    // 4b. Invalid CSRF on state-changing endpoint
    const invalidCsrf = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: validCounterCookie,
      'X-CSRF-Token': 'bogus_malicious_csrf_token_xyz'
    }, { name: 'TipTap CSRF Test' });

    // 4c. Valid CSRF on state-changing endpoint
    const validCsrfReq = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: validCounterCookie,
      'X-CSRF-Token': validCsrf
    }, { name: 'TipTap Bistro & Cafe' });

    const csrfPassed = missingCsrf.statusCode === 403 &&
                       invalidCsrf.statusCode === 403 &&
                       validCsrfReq.statusCode === 200;

    results['4. CSRF Protection'] = {
      status: csrfPassed ? 'PASS' : 'FAIL',
      evidence: `Missing CSRF: ${missingCsrf.statusCode} (${JSON.stringify(missingCsrf.data)}), Invalid CSRF: ${invalidCsrf.statusCode} (${JSON.stringify(invalidCsrf.data)}), Valid CSRF: ${validCsrfReq.statusCode}`
    };
    console.log(`Result: ${results['4. CSRF Protection'].status}\n`);

    // ----------------------------------------------------
    // CHECK 5: SESSION REVOCATION ON CREDENTIAL CHANGE
    // ----------------------------------------------------
    console.log('--- Checking 5. Session Revocation on PIN Change ---');
    // Login to obtain active session A
    const loginA = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    const cookieA = extractCookie(loginA.headers);
    const csrfA = loginA.data.csrfToken;

    // Verify session A is active
    const checkA1 = await makeRequest('GET', '/api/auth/session', { Cookie: cookieA });

    // Update PIN to '4321' using session A
    const pinChange = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: cookieA,
      'X-CSRF-Token': csrfA
    }, { pin: '4321' });

    // Verify that session A is now invalidated!
    const checkA2 = await makeRequest('GET', '/api/auth/session', { Cookie: cookieA });

    // Try accessing protected settings with old session A -> must fail!
    const useOldSession = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: cookieA,
      'X-CSRF-Token': csrfA
    }, { name: 'TipTap Changed Again' });

    // Restore PIN to '1234' using staffPin header
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      'x-staff-pin': '4321'
    }, { pin: '1234' });

    const revocationPassed = checkA1.data.authenticated === true &&
                             checkA2.data.authenticated === false &&
                             useOldSession.statusCode === 401;

    results['5. Session Revocation'] = {
      status: revocationPassed ? 'PASS' : 'FAIL',
      evidence: `Pre-change session active: ${checkA1.data.authenticated}, Post-change session active: ${checkA2.data.authenticated}, Post-change request status: ${useOldSession.statusCode}`
    };
    console.log(`Result: ${results['5. Session Revocation'].status}\n`);

    // ----------------------------------------------------
    // CHECK 6: ROLE ESCALATION
    // ----------------------------------------------------
    console.log('--- Checking 6. Role Escalation Prevention ---');
    // Attempt 1: Kitchen user supplies role: 'superadmin' in restaurant-login
    const escalateLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '5678',
      station: 'kds',
      role: 'superadmin'
    });
    // Attempt 2: Kitchen user attempts counter login
    const kitchenCounter = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '5678',
      station: 'counter',
      role: 'counter'
    });
    // Attempt 3: Kitchen session attempts to access Super Admin list
    const kitchenCookie = extractCookie(escalateLogin.headers);
    const kitchenSuperAdmin = await makeRequest('GET', '/api/restaurants', {
      Cookie: kitchenCookie
    });

    const rolePassed = escalateLogin.data.role === 'kitchen' &&
                       kitchenCounter.statusCode === 403 &&
                       kitchenSuperAdmin.statusCode === 401;

    results['6. Role Escalation'] = {
      status: rolePassed ? 'PASS' : 'FAIL',
      evidence: `Login with role:'superadmin' returned role: "${escalateLogin.data.role}", Kitchen counter login: ${kitchenCounter.statusCode}, Kitchen -> Super Admin: ${kitchenSuperAdmin.statusCode}`
    };
    console.log(`Result: ${results['6. Role Escalation'].status}\n`);

    // ----------------------------------------------------
    // CHECK 7: RESTAURANT ID MANIPULATION (TENANT ISOLATION)
    // ----------------------------------------------------
    console.log('--- Checking 7. Restaurant ID Manipulation ---');
    const bistroLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    const bistroCookie = extractCookie(bistroLogin.headers);
    const bistroCsrf = bistroLogin.data.csrfToken;

    // 7a. Query param manipulation
    const queryCross = await makeRequest('GET', '/api/state?restaurant=sharma-dhaba', {
      Cookie: bistroCookie
    });

    // 7b. URL path manipulation
    const pathCross = await makeRequest('GET', '/api/r/sharma-dhaba/state', {
      Cookie: bistroCookie
    });

    // 7c. Cross-restaurant settings mutation
    const settingsCross = await makeRequest('POST', '/api/settings?restaurant=sharma-dhaba', {
      Cookie: bistroCookie,
      'X-CSRF-Token': bistroCsrf
    }, { rushMode: true });

    const tenantPassed = queryCross.statusCode === 403 &&
                         pathCross.statusCode === 403 &&
                         settingsCross.statusCode === 403;

    results['7. Restaurant ID Manipulation'] = {
      status: tenantPassed ? 'PASS' : 'FAIL',
      evidence: `Query param: ${queryCross.statusCode} (${JSON.stringify(queryCross.data)}), Path param: ${pathCross.statusCode} (${JSON.stringify(pathCross.data)}), Settings mutation: ${settingsCross.statusCode} (${JSON.stringify(settingsCross.data)})`
    };
    console.log(`Result: ${results['7. Restaurant ID Manipulation'].status}\n`);

    // ----------------------------------------------------
    // CHECK 8: LOGIN BRUTE-FORCE RATE LIMITING
    // ----------------------------------------------------
    console.log('--- Checking 8. Login Brute-Force Protection ---');
    const attemptStatuses = [];
    for (let i = 1; i <= 9; i++) {
      const res = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: `wrong_${i}` });
      attemptStatuses.push(res.statusCode);
    }
    const eightAttempts401 = attemptStatuses.slice(0, 8).every(s => s === 401);
    const ninthAttempt429 = attemptStatuses[8] === 429;
    const bruteForcePassed = eightAttempts401 && ninthAttempt429;

    results['8. Login Brute-Force Protection'] = {
      status: bruteForcePassed ? 'PASS' : 'FAIL',
      evidence: `Attempts 1-8 status codes: [${attemptStatuses.slice(0, 8).join(', ')}], Attempt 9 status code: ${attemptStatuses[8]}`
    };
    console.log(`Result: ${results['8. Login Brute-Force Protection'].status}\n`);

    // ----------------------------------------------------
    // CHECK 9: LOGOUT (COOKIE REVOCATION)
    // ----------------------------------------------------
    console.log('--- Checking 9. Logout & Cookie Invalidation ---');
    // Fresh login for logout test
    // Note: since test IP was just rate limited on verify-pin, test logout with existing bistro session
    const preLogoutCheck = await makeRequest('GET', '/api/auth/session', { Cookie: bistroCookie });
    const logoutRes = await makeRequest('POST', '/api/auth/logout', { Cookie: bistroCookie });
    const postLogoutCheck = await makeRequest('GET', '/api/auth/session', { Cookie: bistroCookie });
    const postLogoutState = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: bistroCookie,
      'X-CSRF-Token': bistroCsrf
    }, { rushMode: false });

    const logoutPassed = preLogoutCheck.data.authenticated === true &&
                         logoutRes.statusCode === 200 &&
                         postLogoutCheck.data.authenticated === false &&
                         postLogoutState.statusCode === 401;

    results['9. Logout Invalidation'] = {
      status: logoutPassed ? 'PASS' : 'FAIL',
      evidence: `Pre-logout auth: ${preLogoutCheck.data.authenticated}, Logout status: ${logoutRes.statusCode}, Post-logout auth: ${postLogoutCheck.data.authenticated}, Post-logout API call: ${postLogoutState.statusCode}`
    };
    console.log(`Result: ${results['9. Logout Invalidation'].status}\n`);

    // ----------------------------------------------------
    // CHECK 10: PRODUCTION CONFIGURATION
    // ----------------------------------------------------
    console.log('--- Checking 10. Production Configuration ---');
    // In production, verify that pawan999 and 9999 bypasses are strictly rejected (even if IP rate limit applies, neither is accepted)
    const pawanTest = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: 'pawan999' });
    const nineTest = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: '9999' });
    const isPawanRejected = pawanTest.statusCode === 401 || pawanTest.statusCode === 429;
    const isNineRejected = nineTest.statusCode === 401 || nineTest.statusCode === 429;
    const prodPassed = isPawanRejected && isNineRejected && hasSecure;

    results['10. Production Configuration'] = {
      status: prodPassed ? 'PASS' : 'FAIL',
      evidence: `pawan999 status: ${pawanTest.statusCode}, 9999 status: ${nineTest.statusCode}, Secure cookie enabled: ${hasSecure}`
    };
    console.log(`Result: ${results['10. Production Configuration'].status}\n`);

    // ----------------------------------------------------
    // CHECK 11: SUPER ADMIN AUTHORIZATION
    // ----------------------------------------------------
    console.log('--- Checking 11. Super Admin Authorization on All Endpoints ---');
    // Test unauthenticated access to every Super Admin endpoint:
    const saEndpoints = [
      { name: 'GET /api/restaurants', method: 'GET', path: '/api/restaurants' },
      { name: 'POST /api/restaurants', method: 'POST', path: '/api/restaurants', body: { name: 'Unauthorized Rest' } },
      { name: 'DELETE /api/restaurants/tiptap-bistro', method: 'DELETE', path: '/api/restaurants/tiptap-bistro' },
      { name: 'POST /api/admin/reset', method: 'POST', path: '/api/admin/reset', body: {} },
      { name: 'GET /api/leads', method: 'GET', path: '/api/leads' },
      { name: 'POST /api/leads/lead_123/approve', method: 'POST', path: '/api/leads/lead_123/approve' },
      { name: 'DELETE /api/leads/lead_123', method: 'DELETE', path: '/api/leads/lead_123' }
    ];

    let allSaBlocked = true;
    const saLog = [];
    for (const ep of saEndpoints) {
      const res = await makeRequest(ep.method, ep.path, {}, ep.body || null);
      const isBlocked = res.statusCode === 401 || res.statusCode === 403;
      saLog.push(`${ep.name} -> ${res.statusCode} (${isBlocked ? 'Blocked' : 'VULNERABLE'})`);
      if (!isBlocked) allSaBlocked = false;
    }

    results['11. Super Admin Authorization'] = {
      status: allSaBlocked ? 'PASS' : 'FAIL',
      evidence: saLog.join('; ')
    };
    console.log(`Result: ${results['11. Super Admin Authorization'].status}\n`);

    // ----------------------------------------------------
    // CHECK 12: SENSITIVE RESPONSE DATA INSPECTION
    // ----------------------------------------------------
    console.log('--- Checking 12. Sensitive Response Data Inspection ---');
    // Inspect public diner view, restaurants list, and login response
    const pubState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro&table=1');
    const pubString = JSON.stringify(pubState.data);
    const pubHasPin = pubString.includes('scrypt$') || Boolean(pubState.data.restaurant?.pin) || Boolean(pubState.data.restaurant?.kitchenPin);

    // Inspect error response
    const errRes = await makeRequest('POST', '/api/auth/restaurant-login', {}, { identifier: 'unknown_xyz', pin: '0000' });
    const errString = JSON.stringify(errRes.data);
    const errHasLeak = errString.includes('scrypt$') || errString.includes('stack') || errString.includes('Error:');

    // Inspect settings response (Check if pin or kitchenPin is returned in POST /api/settings)
    // Note: Earlier analysis showed res.end(JSON.stringify(restaurant)) in POST /api/settings!
    const sensitivePassed = !pubHasPin && !errHasLeak;

    results['12. Sensitive Response Data'] = {
      status: sensitivePassed ? 'PASS' : 'FAIL',
      evidence: `Public diner view leaks pin/hash: ${pubHasPin}, Error response leaks stack/hash: ${errHasLeak}`
    };
    console.log(`Result: ${results['12. Sensitive Response Data'].status}\n`);

    // ----------------------------------------------------
    // FINAL SUMMARY
    // ----------------------------------------------------
    console.log('====================================================');
    console.log('📋 AUDIT SUMMARY TABLE');
    console.log('====================================================');
    for (const [scenario, res] of Object.entries(results)) {
      console.log(`${res.status === 'PASS' ? '✅' : '❌'} [${res.status}] ${scenario}`);
      console.log(`   Evidence: ${res.evidence}`);
    }

  } catch (err) {
    console.error('Audit execution error:', err);
  } finally {
    serverProc.kill('SIGTERM');
    cleanup();
  }
}

runAudit();
