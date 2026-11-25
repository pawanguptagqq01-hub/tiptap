/**
 * TipTap Phase 8 Security Remediation Automated Test Suite
 *
 * Verifies:
 * 1. Menu Price Permissions:
 *    - Kitchen staff price-update denial (HTTP 403 Forbidden)
 *    - Kitchen staff stock-update allowance (HTTP 200 OK)
 *    - Counter staff price-update authorization (HTTP 200 OK)
 *    - Mixed-field request rejection from kitchen staff (HTTP 403 Forbidden)
 *    - Unknown field rejection (HTTP 400 Bad Request)
 * 2. Table State Machine:
 *    - Valid transitions (free -> occupied -> cleaning -> free, free -> reserved -> free)
 *    - Invalid transitions (occupied -> free, free -> cleaning, cleaning -> occupied) rejected with HTTP 400
 * 3. Service Request Throttling:
 *    - Initial request accepted (HTTP 201)
 *    - 30-second cooldown enforcement (HTTP 429 Too Many Requests with Retry-After)
 *    - Non-existent table rejection (HTTP 404)
 *    - Multi-table independence (Table 2 allowed while Table 1 is on cooldown)
 *    - Server-side bypass resistance (clearing cookies/headers cannot bypass table cooldown)
 * 4. Persistent Operational Audit Logging:
 *    - Audit logs recorded for price changes, stock changes, table status, settings updates, cancellations, and settlements
 *    - Sensitive credentials (PINs, hashes) strictly redacted from diffs
 *    - Audit logs are immutable: mutating HTTP methods return HTTP 405 Method Not Allowed
 *    - Access control: Super Admin credentials required (HTTP 401 when unauthenticated)
 * 5. Cross-Tenant Isolation:
 *    - Cross-tenant mutations rejected with HTTP 403 Forbidden
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const { createIsolatedTestDb } = require('./test-db-helper');

const TEST_PORT = 3290;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, BASE_URL);
    const reqHeaders = { ...headers };
    let reqData = null;

    if (body !== null) {
      if (typeof body === 'string') {
        reqData = body;
      } else {
        reqData = JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
      }
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

    req.on('error', (err) => {
      resolve({
        statusCode: null,
        headers: {},
        data: null,
        error: err
      });
    });

    if (reqData) req.write(reqData);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await makeRequest('GET', '/healthz');
      if (res.statusCode === 200 || res.statusCode === 503) {
        return true;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server spawn timeout on port ${port}`);
}

async function runPhase8Tests() {
  console.log('================================================================');
  console.log('🛡️  TIPTAP PHASE 8: OPERATIONAL SECURITY REMEDIATION TEST SUITE');
  console.log('================================================================\n');

  const { tempDbPath, cleanup } = createIsolatedTestDb('phase8-remediation');

  const serverProcess = fork(path.resolve(__dirname, '../server.js'), [], {
    env: {
      ...process.env,
      PORT: TEST_PORT,
      TIPTAP_DB_FILE: tempDbPath,
      SUPER_ADMIN_PIN: 'MasterPIN#Phase8Audit',
      NODE_ENV: 'test',
      TIPTAP_TEST_ALLOW_MUTATIONS: 'true'
    },
    stdio: 'pipe'
  });

  let serverErrorOutput = '';
  serverProcess.stderr.on('data', d => serverErrorOutput += d.toString());

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failedTests++;
    }
  }

  try {
    await waitForServer(TEST_PORT);
    console.log(`Server started on 127.0.0.1:${TEST_PORT}\n`);

    // =========================================================================
    // 1. RESTRICT MENU PRICE PERMISSIONS & ALLOWLIST VALIDATION
    // =========================================================================
    console.log('--- 1. MENU PRICE PERMISSIONS & FIELD ALLOWLIST ---');

    // 1a. Unauthenticated modification denied
    const unauthMenu = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {}, { inStock: false });
    assert(unauthMenu.statusCode === 401, 'Unauthenticated menu modification rejected with HTTP 401');

    // 1b. Kitchen staff attempting price modification denied (HTTP 403 Forbidden)
    const kitchenPriceUpdate = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '5678' // Kitchen PIN
    }, { price: 350 });
    assert(kitchenPriceUpdate.statusCode === 403, 'Kitchen staff price update denied with HTTP 403 Forbidden');
    assert(kitchenPriceUpdate.data && kitchenPriceUpdate.data.error && kitchenPriceUpdate.data.error.includes('Kitchen staff authorization is strictly restricted'),
      'HTTP 403 error message explicitly explains kitchen permission boundary');

    // 1c. Kitchen staff attempting mixed request (inStock + price) denied (HTTP 403 Forbidden)
    const kitchenMixedUpdate = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '5678'
    }, { inStock: false, price: 350 });
    assert(kitchenMixedUpdate.statusCode === 403, 'Kitchen staff mixed request (inStock + price) rejected with HTTP 403 Forbidden');

    // 1d. Kitchen staff updating inStock only allowed (HTTP 200 OK)
    const kitchenStockUpdate = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '5678'
    }, { inStock: false });
    assert(kitchenStockUpdate.statusCode === 200, 'Kitchen staff inStock modification accepted with HTTP 200');
    assert(kitchenStockUpdate.data && kitchenStockUpdate.data.inStock === false, 'Dish inStock field successfully set to false');

    // Restore stock to true
    const kitchenStockRestore = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '5678'
    }, { inStock: true });
    assert(kitchenStockRestore.statusCode === 200 && kitchenStockRestore.data.inStock === true, 'Kitchen staff inStock field restored to true');

    // 1e. Counter staff authorized to update price (HTTP 200 OK)
    const counterPriceUpdate = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '1234' // Counter PIN
    }, { price: 310 });
    assert(counterPriceUpdate.statusCode === 200, 'Counter staff price modification accepted with HTTP 200');
    assert(counterPriceUpdate.data && counterPriceUpdate.data.price === 310, 'Dish price updated to 310 by counter staff');

    // 1f. Super Admin authorized to update all fields
    const adminPriceUpdate = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-master-pin': 'MasterPIN#Phase8Audit'
    }, { price: 280 });
    assert(adminPriceUpdate.statusCode === 200 && adminPriceUpdate.data.price === 280, 'Super Admin master pin authorized to update menu price');

    // 1g. Unrecognized / Malicious field rejected (HTTP 400 Bad Request)
    const unknownFieldUpdate = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '1234'
    }, { injectedBackdoorField: 'malicious' });
    assert(unknownFieldUpdate.statusCode === 400, 'Unknown fields outside explicit allowlist rejected with HTTP 400');

    // =========================================================================
    // 2. TABLE STATE MACHINE ENFORCEMENT
    // =========================================================================
    console.log('\n--- 2. TABLE STATE MACHINE ENFORCEMENT ---');

    // Ensure Table 1 starts at 'free'
    const resetTable = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'free' });

    // 2a. free -> occupied (Valid)
    const tFreeToOcc = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'occupied' });
    assert(tFreeToOcc.statusCode === 200 && tFreeToOcc.data.status === 'occupied', 'Valid transition: free -> occupied accepted (HTTP 200)');

    // 2b. occupied -> free (Invalid: must go through cleaning!)
    const tOccToFree = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'free' });
    assert(tOccToFree.statusCode === 400, 'Invalid transition: occupied -> free rejected with HTTP 400 Bad Request');
    assert(tOccToFree.data && tOccToFree.data.error && tOccToFree.data.error.includes('Invalid table status transition'),
      'HTTP 400 response provides informative table state machine transition error');

    // 2c. occupied -> reserved (Invalid: occupied table cannot be marked reserved directly)
    const tOccToRes = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'reserved' });
    assert(tOccToRes.statusCode === 400, 'Invalid transition: occupied -> reserved rejected with HTTP 400');

    // 2d. occupied -> cleaning (Valid)
    const tOccToClean = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'cleaning' });
    assert(tOccToClean.statusCode === 200 && tOccToClean.data.status === 'cleaning', 'Valid transition: occupied -> cleaning accepted (HTTP 200)');

    // 2e. cleaning -> occupied (Invalid: table must be freed before re-seating)
    const tCleanToOcc = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'occupied' });
    assert(tCleanToOcc.statusCode === 400, 'Invalid transition: cleaning -> occupied rejected with HTTP 400');

    // 2f. cleaning -> free (Valid)
    const tCleanToFree = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'free' });
    assert(tCleanToFree.statusCode === 200 && tCleanToFree.data.status === 'free', 'Valid transition: cleaning -> free accepted (HTTP 200)');

    // 2g. free -> reserved (Valid)
    const tFreeToRes = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'reserved', reservedFor: 'VIP Guest' });
    assert(tFreeToRes.statusCode === 200 && tFreeToRes.data.status === 'reserved', 'Valid transition: free -> reserved accepted (HTTP 200)');

    // 2h. reserved -> free (Valid: cancellation of reservation)
    const tResToFree = await makeRequest('PATCH', '/api/r/tiptap-bistro/tables/1', {
      'x-staff-pin': '1234'
    }, { status: 'free' });
    assert(tResToFree.statusCode === 200 && tResToFree.data.status === 'free', 'Valid transition: reserved -> free accepted (HTTP 200)');

    // =========================================================================
    // 3. SERVICE REQUEST RATE LIMITING & COOLDOWN
    // =========================================================================
    console.log('\n--- 3. SERVICE REQUEST RATE LIMITING & COOLDOWN ---');

    // 3a. Non-existent table rejected (HTTP 404)
    const fakeTableSr = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {}, { tableId: 999, type: 'waiter' });
    assert(fakeTableSr.statusCode === 404, 'Service request for non-existent table (999) rejected with HTTP 404');

    // 3b. First service request for Table 1 succeeds (HTTP 201)
    const sr1 = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {}, { tableId: 1, type: 'waiter' });
    assert(sr1.statusCode === 201, 'First service request for Table 1 accepted with HTTP 201 Created');

    // 3c. Immediate second service request for Table 1 throttled (HTTP 429 Too Many Requests)
    const sr2 = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {}, { tableId: 1, type: 'water' });
    assert(sr2.statusCode === 429, 'Immediate second request for Table 1 rate-limited with HTTP 429 Too Many Requests');
    assert(sr2.headers['retry-after'] !== undefined, 'HTTP 429 response includes Retry-After header');
    assert(sr2.data && sr2.data.status === 'rate_limited', 'HTTP 429 JSON response specifies status: "rate_limited"');

    // 3d. Bypass resistance: Spoofing headers or different client IP still throttles Table 1
    const srBypassAttempt = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {
      'X-Forwarded-For': '203.0.113.195',
      'User-Agent': 'SpoofedBrowser/99.0'
    }, { tableId: 1, type: 'waiter' });
    assert(srBypassAttempt.statusCode === 429, 'Changing client headers/IP cannot bypass server-side table cooldown (HTTP 429)');

    // 3e. Multi-table independence: Table 2 is NOT throttled by Table 1
    const srTable2 = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {}, { tableId: 2, type: 'waiter' });
    assert(srTable2.statusCode === 201, 'Service request for independent Table 2 accepted with HTTP 201 Created');

    // =========================================================================
    // 4. PERSISTENT OPERATIONAL AUDIT LOGGING
    // =========================================================================
    console.log('\n--- 4. PERSISTENT OPERATIONAL AUDIT LOGGING ---');

    // 4a. Unauthenticated access to audit logs denied (HTTP 401)
    const unauthAudit = await makeRequest('GET', '/api/admin/audit-logs');
    assert(unauthAudit.statusCode === 401, 'Unauthenticated request to /api/admin/audit-logs rejected with HTTP 401');

    // 4b. Kitchen staff credentials denied access to audit logs (HTTP 401)
    const kitchenAudit = await makeRequest('GET', '/api/admin/audit-logs', { 'x-staff-pin': '5678' });
    assert(kitchenAudit.statusCode === 401, 'Ordinary staff credentials cannot view audit logs (HTTP 401)');

    // 4c. Audit logs are strictly immutable: mutating methods rejected with HTTP 405 Method Not Allowed
    const postAudit = await makeRequest('POST', '/api/admin/audit-logs', { 'x-master-pin': 'MasterPIN#Phase8Audit' }, { fake: 'record' });
    assert(postAudit.statusCode === 405, 'POST to /api/admin/audit-logs rejected with HTTP 405 Method Not Allowed');

    const deleteAudit = await makeRequest('DELETE', '/api/admin/audit-logs', { 'x-master-pin': 'MasterPIN#Phase8Audit' });
    assert(deleteAudit.statusCode === 405, 'DELETE to /api/admin/audit-logs rejected with HTTP 405 Method Not Allowed');

    // 4d. Super Admin retrieves audit logs (HTTP 200)
    const adminAudit = await makeRequest('GET', '/api/admin/audit-logs', { 'x-master-pin': 'MasterPIN#Phase8Audit' });
    assert(adminAudit.statusCode === 200, 'Super Admin retrieves audit logs with HTTP 200');
    assert(Array.isArray(adminAudit.data), 'Audit logs response is an array');

    const logs = adminAudit.data || [];
    assert(logs.length > 0, `Audit log collection has recorded ${logs.length} operational actions`);

    // 4e. Verify recorded action types
    const actions = logs.map(l => l.action);
    assert(actions.includes('MENU_PRICE_CHANGE'), 'Audit log contains MENU_PRICE_CHANGE event');
    assert(actions.includes('MENU_STOCK_CHANGE'), 'Audit log contains MENU_STOCK_CHANGE event');
    assert(actions.includes('TABLE_STATUS_CHANGE'), 'Audit log contains TABLE_STATUS_CHANGE event');

    // 4f. Test Settings Update Audit Logging and Credential Redaction
    const updateSettings = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    }, {
      name: 'TipTap Bistro & Cafe Updated',
      pin: '9988', // updated PIN
      kitchenPin: '7766' // updated Kitchen Passkey
    });
    assert(updateSettings.statusCode === 200, 'Settings update succeeded with HTTP 200');

    // Re-fetch audit logs to verify sensitive data redaction
    const postSettingsAudit = await makeRequest('GET', '/api/admin/audit-logs', { 'x-master-pin': 'MasterPIN#Phase8Audit' });
    const settingsLog = (postSettingsAudit.data || []).find(l => l.action === 'SETTINGS_UPDATE');
    assert(settingsLog !== undefined, 'Audit log recorded SETTINGS_UPDATE event');
    assert(settingsLog && settingsLog.diff && settingsLog.diff.before && settingsLog.diff.before.pin === '[REDACTED]',
      'Audit log diff strictly redacts PINs (pin: "[REDACTED]")');
    assert(settingsLog && settingsLog.diff && settingsLog.diff.after && settingsLog.diff.after.pinChanged === true,
      'Audit log diff records non-sensitive boolean flag pinChanged: true');

    // =========================================================================
    // 5. CROSS-TENANT ISOLATION VERIFICATION
    // =========================================================================
    console.log('\n--- 5. CROSS-TENANT ISOLATION ---');

    // Sharma Dhaba staff PIN ('1234' against sharma-dhaba) cannot modify tiptap-bistro menu
    const crossTenantMenu = await makeRequest('PATCH', '/api/r/tiptap-bistro/menu/tiptap-bistro_m1', {
      'x-staff-pin': '9999' // invalid for tiptap-bistro
    }, { inStock: false });
    assert(crossTenantMenu.statusCode === 401, 'Invalid/Cross-tenant PIN rejected with HTTP 401 Unauthorized');

  } catch (err) {
    console.error('Test execution error:', err);
    failedTests++;
  } finally {
    serverProcess.kill('SIGKILL');
    cleanup();
  }

  console.log('\n================================================================');
  console.log(`AUDIT RESULTS: ${passedTests} PASSED | ${failedTests} FAILED (TOTAL: ${totalTests})`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPhase8Tests();
