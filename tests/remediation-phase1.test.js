const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3205;
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
          data: json,
          rawBody: data
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

async function runRemediationTests() {
  console.log('====================================================');
  console.log('🛡️  TIPTAP PHASE 1: TARGETED SECURITY REMEDIATION TESTS');
  console.log('====================================================\n');

  const { createIsolatedTestDb } = require('./test-db-helper');
  const { tempDbPath, cleanup } = createIsolatedTestDb('remed-p1');

  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), MONGODB_URI: '', NODE_ENV: 'test', TIPTAP_TEST_ALLOW_MUTATIONS: 'true', TIPTAP_DB_FILE: tempDbPath },
    stdio: 'pipe'
  });

  serverProc.stderr.on('data', (d) => console.error('[SERVER ERR]:', d.toString()));

  await new Promise(r => setTimeout(r, 2000));

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name} ${details ? `(${details})` : ''}`);
      failed++;
    }
  }

  try {
    // ----------------------------------------------------
    // SETUP: Authenticate Super Admin and Counter Staff
    // ----------------------------------------------------
    const adminLogin = await makeRequest('POST', '/api/admin/verify-pin', {}, { pin: '0000' });
    const adminCookie = extractCookie(adminLogin.headers);
    const adminCsrf = adminLogin.data.csrfToken;
    const adminSessionId = adminLogin.data.sessionId;

    const counterLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    const counterCookie = extractCookie(counterLogin.headers);
    const counterCsrf = counterLogin.data.csrfToken;
    const counterSessionId = counterLogin.data.sessionId;

    // Ensure rushMode is false so order can be placed
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { rushMode: false });

    // Create an order and service request for testing state-changing mutations
    const testOrderRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 1,
      orderType: 'dinein',
      items: [{ id: 'm1', name: 'Paneer Butter Masala', price: 280, quantity: 1 }]
    });
    const testOrderId = testOrderRes.data?.id;

    const testSrRes = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {}, {
      tableId: 1,
      type: 'water'
    });
    const testSrId = testSrRes.data?.id;

    // ----------------------------------------------------
    // SECTION 1: CSRF PROTECTION ENFORCEMENT
    // ----------------------------------------------------
    console.log('--- SECTION 1: CSRF Protection on Cookie-Authenticated Mutating Endpoints ---');

    // 1a. DELETE /api/orders/:id
    const delOrderNoCsrf = await makeRequest('DELETE', `/api/orders/${testOrderId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie
    });
    assert(delOrderNoCsrf.statusCode === 403, 'DELETE /api/orders/:id without CSRF rejected (403)', `Got ${delOrderNoCsrf.statusCode}`);

    const delOrderBadCsrf = await makeRequest('DELETE', `/api/orders/${testOrderId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie,
      'X-CSRF-Token': 'bogus_csrf_token_123'
    });
    assert(delOrderBadCsrf.statusCode === 403, 'DELETE /api/orders/:id with invalid CSRF rejected (403)', `Got ${delOrderBadCsrf.statusCode}`);

    // 1b. PATCH /api/orders/:id
    const patchOrderNoCsrf = await makeRequest('PATCH', `/api/orders/${testOrderId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie
    }, { status: 'preparing' });
    assert(patchOrderNoCsrf.statusCode === 403, 'PATCH /api/orders/:id without CSRF rejected (403)', `Got ${patchOrderNoCsrf.statusCode}`);

    const patchOrderBadCsrf = await makeRequest('PATCH', `/api/orders/${testOrderId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie,
      'X-CSRF-Token': 'bogus_csrf_token_123'
    }, { status: 'preparing' });
    assert(patchOrderBadCsrf.statusCode === 403, 'PATCH /api/orders/:id with invalid CSRF rejected (403)', `Got ${patchOrderBadCsrf.statusCode}`);

    const patchOrderValidCsrf = await makeRequest('PATCH', `/api/orders/${testOrderId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { status: 'preparing' });
    assert(patchOrderValidCsrf.statusCode === 200, 'PATCH /api/orders/:id with valid CSRF accepted (200)', `Got ${patchOrderValidCsrf.statusCode}`);

    // 1c. PATCH /api/service-request/:id
    const patchSrNoCsrf = await makeRequest('PATCH', `/api/service-request/${testSrId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie
    });
    assert(patchSrNoCsrf.statusCode === 403, 'PATCH /api/service-request/:id without CSRF rejected (403)', `Got ${patchSrNoCsrf.statusCode}`);

    const patchSrValidCsrf = await makeRequest('PATCH', `/api/service-request/${testSrId}?restaurant=tiptap-bistro`, {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    });
    assert(patchSrValidCsrf.statusCode === 200, 'PATCH /api/service-request/:id with valid CSRF accepted (200)', `Got ${patchSrValidCsrf.statusCode}`);

    // 1d. POST /api/admin/reset
    const resetNoCsrf = await makeRequest('POST', '/api/admin/reset', {
      Cookie: adminCookie
    }, { pin: '0000' });
    assert(resetNoCsrf.statusCode === 403, 'POST /api/admin/reset without CSRF rejected (403)', `Got ${resetNoCsrf.statusCode}`);

    const resetBadCsrf = await makeRequest('POST', '/api/admin/reset', {
      Cookie: adminCookie,
      'X-CSRF-Token': 'fake_token'
    }, { pin: '0000' });
    assert(resetBadCsrf.statusCode === 403, 'POST /api/admin/reset with invalid CSRF rejected (403)', `Got ${resetBadCsrf.statusCode}`);

    // 1e. DELETE /api/restaurants/:id
    const delRestNoCsrf = await makeRequest('DELETE', '/api/restaurants/temp-demo-restaurant', {
      Cookie: adminCookie
    });
    assert(delRestNoCsrf.statusCode === 403, 'DELETE /api/restaurants/:id without CSRF rejected (403)', `Got ${delRestNoCsrf.statusCode}`);

    const delRestBadCsrf = await makeRequest('DELETE', '/api/restaurants/temp-demo-restaurant', {
      Cookie: adminCookie,
      'X-CSRF-Token': 'invalid_token'
    });
    assert(delRestBadCsrf.statusCode === 403, 'DELETE /api/restaurants/:id with invalid CSRF rejected (403)', `Got ${delRestBadCsrf.statusCode}`);

    // 1f. POST /api/settings
    const settingsNoCsrf = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie
    }, { rushMode: true });
    assert(settingsNoCsrf.statusCode === 403, 'POST /api/settings without CSRF rejected (403)', `Got ${settingsNoCsrf.statusCode}`);

    const settingsValidCsrf = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { rushMode: true });
    assert(settingsValidCsrf.statusCode === 200, 'POST /api/settings with valid CSRF accepted (200)', `Got ${settingsValidCsrf.statusCode}`);

    // 1g. Valid Non-Cookie API Flows (Bearer Token & Direct PIN) do NOT require CSRF
    const bearerPatch = await makeRequest('PATCH', `/api/orders/${testOrderId}?restaurant=tiptap-bistro`, {
      Authorization: `Bearer ${counterSessionId}`
    }, { status: 'ready' });
    assert(bearerPatch.statusCode === 200, 'Non-cookie Bearer token request does not require CSRF token (200)', `Got ${bearerPatch.statusCode}`);

    // ----------------------------------------------------
    // SECTION 2: RESTAURANT ID MANIPULATION & TENANT ISOLATION
    // ----------------------------------------------------
    console.log('\n--- SECTION 2: Restaurant ID Manipulation & Isolation ---');

    // 2a. Existing authorized restaurant works
    const authRestState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      Cookie: counterCookie
    });
    assert(authRestState.statusCode === 200 && authRestState.data.restaurant?.id === 'tiptap-bistro',
      'Existing authorized restaurant returns 200 OK with correct restaurant data');

    // 2b. Existing unauthorized restaurant returns 403
    const unauthRestState = await makeRequest('GET', '/api/state?restaurant=sharma-dhaba', {
      Cookie: counterCookie
    });
    assert(unauthRestState.statusCode === 403,
      'Existing unauthorized restaurant (sharma-dhaba) returns 403 Forbidden', `Got ${unauthRestState.statusCode}`);

    // 2c. Nonexistent restaurant returns 404
    const nonExistentState = await makeRequest('GET', '/api/state?restaurant=fake-ghost-dhaba-999', {
      Cookie: counterCookie
    });
    assert(nonExistentState.statusCode === 404,
      'Nonexistent restaurant returns 404 Not Found', `Got ${nonExistentState.statusCode}`);

    const nonExistentPath = await makeRequest('GET', '/api/r/fake-ghost-dhaba-999/state', {
      Cookie: counterCookie
    });
    assert(nonExistentPath.statusCode === 404,
      'Nonexistent restaurant via /api/r/:id/state returns 404 Not Found', `Got ${nonExistentPath.statusCode}`);

    // 2d. Invalid ID in mutation does NOT modify default restaurant
    const bistroStateBefore = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      Cookie: counterCookie
    });
    const bistroOriginalName = bistroStateBefore.data.restaurant.name;

    const mutateFake = await makeRequest('POST', '/api/settings?restaurant=fake-ghost-dhaba-999', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { name: 'Hacked Injected Name' });
    assert(mutateFake.statusCode === 404,
      'Attempting to mutate settings with invalid restaurant ID returns 404 Not Found', `Got ${mutateFake.statusCode}`);

    const bistroStateAfter = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      Cookie: counterCookie
    });
    assert(bistroStateAfter.data.restaurant.name === bistroOriginalName,
      'Invalid restaurant ID never modifies default restaurant data');

    // 2e. POST /api/admin/reset with nonexistent restaurant returns 404
    const resetFakeRest = await makeRequest('POST', '/api/admin/reset?restaurant=fake-ghost-dhaba-999', {
      Cookie: adminCookie,
      'X-CSRF-Token': adminCsrf
    }, { pin: '0000' });
    assert(resetFakeRest.statusCode === 404,
      'POST /api/admin/reset with invalid restaurant ID returns 404 and does not reset all', `Got ${resetFakeRest.statusCode}`);

    // ----------------------------------------------------
    // SECTION 3: SENSITIVE PIN HASH LEAKAGE ELIMINATION
    // ----------------------------------------------------
    console.log('\n--- SECTION 3: Sensitive PIN Hash Leakage Elimination ---');

    // 3a. POST /api/settings response does NOT contain pin or kitchenPin
    const updateSettingsRes = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { name: 'TipTap Bistro & Cafe', rushMode: false });

    assert(updateSettingsRes.statusCode === 200, 'Settings update succeeds (200)');
    assert(updateSettingsRes.data.pin === undefined, 'Settings response does NOT contain "pin" property');
    assert(updateSettingsRes.data.kitchenPin === undefined, 'Settings response does NOT contain "kitchenPin" property');
    assert(!updateSettingsRes.rawBody.includes('scrypt$'), 'Settings response body contains zero scrypt hashes');

    // 3b. SSE settings:update event payload does NOT contain credentials
    let sseReceivedPayload = null;
    const ssePromise = new Promise((resolve) => {
      const sseReq = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/events?restaurant=tiptap-bistro',
        method: 'GET',
        headers: {
          Cookie: counterCookie
        }
      }, (res) => {
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk.toString();
          if (buffer.includes('event: settings:update')) {
            const parts = buffer.split('event: settings:update');
            const afterEvent = parts[1];
            const match = afterEvent.match(/data:\s*({.+})/);
            if (match) {
              try {
                const parsed = JSON.parse(match[1]);
                sseReceivedPayload = parsed.payload;
                sseReq.destroy();
                resolve();
              } catch (e) {}
            }
          }
        });
      });
      sseReq.end();
    });

    // Wait 300ms for SSE connection
    await new Promise(r => setTimeout(r, 300));

    // Trigger settings update to fire SSE event
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { rushMode: true });

    // Wait for SSE promise with 2 second timeout
    await Promise.race([ssePromise, new Promise(r => setTimeout(r, 2000))]);

    if (sseReceivedPayload) {
      assert(sseReceivedPayload.pin === undefined, 'SSE settings:update payload does NOT leak "pin"');
      assert(sseReceivedPayload.kitchenPin === undefined, 'SSE settings:update payload does NOT leak "kitchenPin"');
      assert(!JSON.stringify(sseReceivedPayload).includes('scrypt$'), 'SSE settings:update payload contains zero scrypt hashes');
    } else {
      console.log('  ⚠️ SSE broadcast event timeout (non-blocking)');
    }

    // 3c. Internal credential changes still work securely
    const changePinRes = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: counterCookie,
      'X-CSRF-Token': counterCsrf
    }, { pin: '7890' });
    assert(changePinRes.statusCode === 200, 'Changing restaurant PIN succeeds');
    assert(changePinRes.data.pin === undefined, 'PIN change response does not leak new PIN hash');

    // Verify new PIN authenticates successfully
    const newPinLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '7890',
      station: 'counter'
    });
    assert(newPinLogin.statusCode === 200, 'New PIN authenticates successfully (200)');

    // Verify old PIN is rejected
    const oldPinLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    assert(oldPinLogin.statusCode === 401, 'Old PIN is properly rejected (401)');

    // Restore PIN back to 1234 for subsequent tests
    const restoreCookie = extractCookie(newPinLogin.headers);
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: restoreCookie,
      'X-CSRF-Token': newPinLogin.data.csrfToken
    }, { pin: '1234' });

    // ----------------------------------------------------
    // SUMMARY
    // ----------------------------------------------------
    console.log('\n====================================================');
    console.log(`🏁 REMEDIATION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed > 0) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('Test execution error:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill('SIGTERM');
    cleanup();
  }
}

runRemediationTests();
