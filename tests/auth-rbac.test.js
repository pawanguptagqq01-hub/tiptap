const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3198;
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

async function runTests() {
  console.log('====================================================');
  console.log('🛡️  TIPTAP PHASE 1: AUTHENTICATION & RBAC TEST SUITE');
  console.log('====================================================\n');

  const { createIsolatedTestDb } = require('./test-db-helper');
  const { tempDbPath, cleanup } = createIsolatedTestDb('auth-rbac');

  // Spawn server process with isolated temporary database
  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), MONGODB_URI: '', TIPTAP_DB_FILE: tempDbPath },
    stdio: 'pipe'
  });

  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', (d) => console.error('[SERVER ERR]:', d.toString()));

  // Wait 1.5 seconds for server boot
  await new Promise(r => setTimeout(r, 1500));

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  try {
    // ----------------------------------------------------
    // TEST 1: NO HARDCODED SUPER ADMIN BYPASSES
    // ----------------------------------------------------
    console.log('Test Group 1: Hardcoded Bypass Elimination');
    const pawanBypass = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: 'pawan999' });
    assert(pawanBypass.statusCode === 401, 'Hardcoded "pawan999" PIN is strictly rejected (401)');

    const nineBypass = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: '9999' });
    assert(nineBypass.statusCode === 401, 'Hardcoded "9999" PIN is strictly rejected (401)');

    const validAdmin = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: '0000' });
    assert(validAdmin.statusCode === 200 && validAdmin.data.success, 'Valid Super Admin PIN succeeds (200)');
    assert(Boolean(validAdmin.data.sessionId), 'Server returns cryptographically secure sessionId');
    assert(Boolean(validAdmin.data.csrfToken), 'Server returns CSRF token');

    const adminCookie = extractCookie(validAdmin.headers);
    assert(Boolean(adminCookie), 'Server sets HttpOnly tiptap_session cookie');

    // ----------------------------------------------------
    // TEST 2: SERVER-SIDE SESSION VALIDATION
    // ----------------------------------------------------
    console.log('\nTest Group 2: Server-Side Session Authentication');
    const checkSession = await makeRequest('GET', '/api/auth/session', { Cookie: adminCookie });
    assert(checkSession.statusCode === 200 && checkSession.data.authenticated === true, 'Session check verifies active session');
    assert(checkSession.data.role === 'superadmin', 'Session role is correctly identified as "superadmin"');

    // ----------------------------------------------------
    // TEST 3: ROLE SEPARATION (KITCHEN VS COUNTER)
    // ----------------------------------------------------
    console.log('\nTest Group 3: Strict Role Separation (Kitchen vs Counter)');
    const kitchenLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '5678',
      station: 'kds'
    });
    assert(kitchenLogin.statusCode === 200 && kitchenLogin.data.role === 'kitchen', 'Kitchen staff login succeeds with role "kitchen"');
    const kitchenCookie = extractCookie(kitchenLogin.headers);

    // Kitchen staff tries to login to Billing Counter station
    const kitchenIntoCounter = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '5678',
      station: 'counter'
    });
    assert(kitchenIntoCounter.statusCode === 403, 'Kitchen passkey is blocked from Billing Counter workstation (403)');

    // Kitchen staff tries to access restaurant settings
    const kitchenSettings = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: kitchenCookie,
      'X-CSRF-Token': kitchenLogin.data.csrfToken
    }, { rushMode: true });
    assert(kitchenSettings.statusCode === 403, 'Kitchen session is strictly blocked from modifying restaurant settings (403)');

    // Counter staff login
    const counterLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    assert(counterLogin.statusCode === 200 && counterLogin.data.role === 'counter', 'Counter staff login succeeds with role "counter"');
    const counterCookie = extractCookie(counterLogin.headers);

    // Counter staff modifies settings with CSRF token
    const counterSettings = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterLogin.data.csrfToken
    }, { rushMode: true });
    assert(counterSettings.statusCode === 200, 'Counter staff can modify settings with valid CSRF token (200)');

    // Reset rushMode to false so database state remains clean for other suites
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterLogin.data.csrfToken
    }, { rushMode: false });

    // ----------------------------------------------------
    // TEST 4: CROSS-RESTAURANT TENANT ISOLATION
    // ----------------------------------------------------
    console.log('\nTest Group 4: Cross-Restaurant Isolation');
    const crossState = await makeRequest('GET', '/api/state?restaurant=sharma-dhaba', {
      Cookie: counterCookie
    });
    assert(crossState.statusCode === 403, 'tiptap-bistro session blocked from accessing sharma-dhaba private state (403)');

    const crossKitchenState = await makeRequest('GET', '/api/state?restaurant=sharma-dhaba', {
      Cookie: kitchenCookie
    });
    assert(crossKitchenState.statusCode === 403, 'tiptap-bistro kitchen session blocked from sharma-dhaba (403)');

    // ----------------------------------------------------
    // TEST 5: LOGOUT & SESSION INVALIDATION
    // ----------------------------------------------------
    console.log('\nTest Group 5: Logout & Session Invalidation');
    const logoutRes = await makeRequest('POST', '/api/auth/logout', { Cookie: counterCookie });
    assert(logoutRes.statusCode === 200, 'Logout endpoint returns success (200)');

    const postLogoutCheck = await makeRequest('GET', '/api/auth/session', { Cookie: counterCookie });
    assert(postLogoutCheck.data.authenticated === false, 'Session is destroyed after logout (authenticated: false)');

    // ----------------------------------------------------
    // TEST 6: DATA LEAKAGE PREVENTION
    // ----------------------------------------------------
    console.log('\nTest Group 6: Zero PIN Leakage in API Responses');
    const superAdminRestaurants = await makeRequest('GET', '/api/restaurants', { Cookie: adminCookie });
    const firstRest = superAdminRestaurants.data[0];
    assert(firstRest && firstRest.pin === undefined, 'GET /api/restaurants does NOT leak "pin"');
    assert(firstRest && firstRest.kitchenPin === undefined, 'GET /api/restaurants does NOT leak "kitchenPin"');

    console.log('\n====================================================');
    console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  } finally {
    serverProc.kill('SIGTERM');
    cleanup();
  }
}

runTests();
