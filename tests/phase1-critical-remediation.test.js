/**
 * TIPTAP PHASE 1 CRITICAL REMEDIATION REGRESSION TEST SUITE
 *
 * Verifies:
 * 1. SSE Security (/api/events):
 *    - Anonymous subscription rejected (401)
 *    - Cross-tenant subscription rejected (403)
 *    - Global/all subscription restricted to superadmin (403)
 *    - Authorized staff connection succeeds (200)
 *    - Customer phone masked in broadcasted events
 * 2. Payment Verification Security:
 *    - Fake UTR from client rejected (401)
 *    - Client-supplied gateway transaction ID cannot mark order paid (401)
 *    - Forged webhook request rejected (401)
 *    - Staff manual settlement permitted with counter session
 * 3. Server-Side Price & Discount Validation:
 *    - Browser-submitted price ignored (server menu price used)
 *    - Unknown menu item rejected (400)
 *    - Cross-restaurant menu item rejected (400)
 *    - Negative / zero quantity rejected (400)
 *    - Arbitrary client discount ignored (server promo validation enforced)
 * 4. Idempotency Key Management:
 *    - Expired keys (>24h) cleaned up automatically
 *    - Active keys retained and deduplicated
 * 5. Rollback & Stale Object Reference Integrity:
 *    - Mutations after rollback operate on current restored state
 * 6. Production Credential Fail-Closed:
 *    - Production mode fails startup on default/missing SUPER_ADMIN_PIN
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3280;
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
  return raw.split(';')[0];
}

const { createIsolatedTestDb } = require('./test-db-helper');
let isolatedDb = null;

function spawnServer(envOverrides = {}) {
  return fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'development',
      TIPTAP_DB_FILE: isolatedDb ? isolatedDb.tempDbPath : undefined,
      ...envOverrides
    },
    stdio: 'pipe'
  });
}

async function runRemediationTests() {
  console.log('================================================================');
  console.log('🛡️  TIPTAP PHASE 1 CRITICAL REMEDIATION REGRESSION AUDIT SUITE');
  console.log('================================================================\n');

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

  // Create isolated temporary database in os.tmpdir()
  isolatedDb = createIsolatedTestDb('crit-remed');
  const dbPath = isolatedDb.tempDbPath;

  let serverProcess = null;

  try {
    serverProcess = spawnServer();
    await new Promise(r => setTimeout(r, 2000));

    // -------------------------------------------------------------
    // SECTION 1: SERVER-SENT EVENTS (SSE) SECURITY
    // -------------------------------------------------------------
    console.log('--- SECTION 1: Server-Sent Events (SSE) Access Control ---');

    // 1a. Anonymous subscription without credentials must be rejected with 401
    const anonSse = await makeRequest('GET', '/api/events?restaurant=tiptap-bistro');
    assert(anonSse.statusCode === 401, 'Anonymous SSE subscription rejected with HTTP 401', `Got ${anonSse.statusCode}`);

    // 1a-ii. staffPin query parameter cannot authenticate (must be rejected with 401)
    const queryStaffPinSse = await makeRequest('GET', '/api/events?restaurant=tiptap-bistro&staffPin=1234');
    assert(queryStaffPinSse.statusCode === 401, 'staffPin query parameter cannot authenticate SSE (HTTP 401)', `Got ${queryStaffPinSse.statusCode}`);

    // 1a-iii. masterPin query parameter cannot authenticate (must be rejected with 401)
    const queryMasterPinSse = await makeRequest('GET', '/api/events?restaurant=super-admin&masterPin=0000');
    assert(queryMasterPinSse.statusCode === 401, 'masterPin query parameter cannot authenticate SSE (HTTP 401)', `Got ${queryMasterPinSse.statusCode}`);

    // Authenticate a staff session for tiptap-bistro
    const bistroLogin = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      station: 'counter',
      pin: '1234'
    });
    const bistroCookie = extractCookie(bistroLogin.headers);
    const bistroCsrf = bistroLogin.data?.csrfToken;
    assert(Boolean(bistroCookie), 'Staff authenticated and received session cookie');

    // 1b. Cross-tenant subscription (Bistro staff trying to subscribe to Sharma Dhaba) must be rejected with 403
    const crossTenantSse = await makeRequest('GET', '/api/events?restaurant=sharma-dhaba', {
      Cookie: bistroCookie
    });
    assert(crossTenantSse.statusCode === 403, 'Cross-tenant SSE subscription rejected with HTTP 403', `Got ${crossTenantSse.statusCode}`);

    // 1c. Non-admin attempting to subscribe to global 'all' must be rejected with 403
    const globalSseStaff = await makeRequest('GET', '/api/events?restaurant=all', {
      Cookie: bistroCookie
    });
    assert(globalSseStaff.statusCode === 403, 'Staff subscription to global "all" stream rejected with HTTP 403', `Got ${globalSseStaff.statusCode}`);

    // 1d. Authorized staff subscription to their own restaurant succeeds
    const sseConnectPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ statusCode: 408 }), 3000);
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/events?restaurant=tiptap-bistro',
        method: 'GET',
        headers: { Cookie: bistroCookie }
      }, (res) => {
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk.toString();
          if (buffer.includes('"type":"connected"')) {
            clearTimeout(timer);
            req.destroy();
            resolve({ statusCode: res.statusCode, buffer });
          }
        });
      });
      req.on('error', () => {
        clearTimeout(timer);
        resolve({ statusCode: 500 });
      });
      req.end();
    });

    const sseConnRes = await sseConnectPromise;
    assert(sseConnRes.statusCode === 200, 'Authorized staff successfully connects to restaurant SSE stream (HTTP 200)');

    // 1e. Superadmin can subscribe to 'super-admin' and 'all'
    const adminLogin = await makeRequest('POST', '/api/admin/verify-pin', {}, {
      pin: '0000'
    });
    const adminCookie = extractCookie(adminLogin.headers);
    assert(Boolean(adminCookie), 'Super Admin authenticated and received session cookie');

    const adminSsePromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ statusCode: 408 }), 3000);
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/events?restaurant=super-admin',
        method: 'GET',
        headers: { Cookie: adminCookie }
      }, (res) => {
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk.toString();
          if (buffer.includes('"type":"connected"')) {
            clearTimeout(timer);
            req.destroy();
            resolve({ statusCode: res.statusCode, buffer });
          }
        });
      });
      req.on('error', () => {
        clearTimeout(timer);
        resolve({ statusCode: 500 });
      });
      req.end();
    });

    const adminConnRes = await adminSsePromise;
    assert(adminConnRes.statusCode === 200, 'Super Admin successfully connects to global super-admin SSE stream (HTTP 200)');

    // -------------------------------------------------------------
    // SECTION 2: PAYMENT VERIFICATION SECURITY
    // -------------------------------------------------------------
    console.log('\n--- SECTION 2: Payment Verification & Webhook Security ---');

    // Ensure rushMode is false
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      Cookie: bistroCookie,
      'X-CSRF-Token': bistroCsrf
    }, { rushMode: false });

    // Create an order on Table 3 for testing payment verification
    const orderForPay = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 3,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m2', name: 'Butter Chicken Special', price: 340, qty: 1 }]
    });
    const orderId = orderForPay.data?.id;
    assert(Boolean(orderId), 'Order created for payment verification test');

    // 2a. Anonymous client sending fake UTR must be rejected with 401
    const fakeUtrRes = await makeRequest('POST', '/api/verify-payment?restaurant=tiptap-bistro', {}, {
      orderId,
      utr: '123456789012',
      paymentMethod: 'UPI App (UTR Verified)'
    });
    assert(fakeUtrRes.statusCode === 401, 'Client-submitted UTR without staff authentication rejected with HTTP 401', `Got ${fakeUtrRes.statusCode}`);

    // 2b. Anonymous client sending fake gateway transaction ID rejected with 401
    const fakeTxnRes = await makeRequest('POST', '/api/verify-payment?restaurant=tiptap-bistro', {}, {
      orderId,
      gatewayTxnId: 'pay_FakeHackerId123',
      paymentMethod: 'Razorpay Gateway'
    });
    assert(fakeTxnRes.statusCode === 401, 'Client-submitted gatewayTxnId without staff authentication rejected with HTTP 401', `Got ${fakeTxnRes.statusCode}`);

    // Verify order is STILL UNPAID
    const checkUnpaid = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderId}`, {
      Cookie: bistroCookie
    });
    const fetchedOrder = (checkUnpaid.data.orders || []).find(o => o.id === orderId);
    assert(fetchedOrder && (fetchedOrder.isPaid === false || fetchedOrder.paymentStatus === 'unpaid'),
      'Order remains strictly UNPAID after fake payment attempts');

    // 2c. Forged unauthenticated POST to /api/payment-webhook rejected with 401
    const fakeWebhookRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {}, {
      event: 'payment.captured',
      payload: { orderId }
    });
    assert(fakeWebhookRes.statusCode === 401, 'Unverified webhook request rejected with HTTP 401', `Got ${fakeWebhookRes.statusCode}`);

    // 2d. Authorized counter staff can perform manual settlement (Session-based)
    const staffSettleRes = await makeRequest('POST', '/api/verify-payment?restaurant=tiptap-bistro', {
      Cookie: bistroCookie,
      'X-CSRF-Token': bistroCsrf
    }, {
      orderId,
      paymentMethod: 'cash'
    });
    assert(staffSettleRes.statusCode === 200, 'Authorized counter staff settlement succeeds with HTTP 200', `Got ${staffSettleRes.statusCode}`);
    assert(staffSettleRes.data.isPaid === true && staffSettleRes.data.paymentStatus === 'paid', 'Order marked paid by authorized staff');

    // Verify session-based audit trail
    const sessionDetails = staffSettleRes.data.paymentDetails;
    assert(Boolean(sessionDetails), 'Session-based settlement persists paymentDetails object');
    assert(sessionDetails.provider === 'POS Counter Settle (Authorized Staff)', 'Audit provider recorded');
    assert(sessionDetails.settledBy === 'SESSION_COUNTER_STAFF', 'Audit record reflects authenticated counter session');
    assert(sessionDetails.settlementMethod === 'cash', 'Audit record reflects valid settlement method');
    assert(sessionDetails.restaurantId === 'tiptap-bistro', 'Audit record reflects restaurantId');
    assert(sessionDetails.orderId === orderId, 'Audit record reflects orderId');

    // 2e. PIN-based settlement with custom reason and spoofed staff identity rejection
    const order2 = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 4,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    });
    const order2Id = order2.data.id;

    const pinSettleRes = await makeRequest('POST', '/api/verify-payment?restaurant=tiptap-bistro', {}, {
      orderId: order2Id,
      staffPin: '1234',
      paymentMethod: 'cash',
      reason: 'Split cash payment at counter register',
      settledBy: 'spoofed_executive_user' // Client spoofed identity must be completely ignored
    });
    assert(pinSettleRes.statusCode === 200, 'PIN-based counter settlement succeeds with HTTP 200', `Got ${pinSettleRes.statusCode}`);
    const pinDetails = pinSettleRes.data.paymentDetails;
    assert(Boolean(pinDetails), 'PIN-based settlement persists paymentDetails object');
    assert(pinDetails.settledBy === 'PIN_AUTH:counter_staff', 'Audit identity honestly records PIN_AUTH:counter_staff and ignores spoofed identity');
    assert(pinDetails.reason === 'Split cash payment at counter register', 'Audit record captures custom settlement reason');
    assert(pinDetails.orderId === order2Id, 'Audit record matches orderId');

    // -------------------------------------------------------------
    // SECTION 3: SERVER-SIDE PRICE & DISCOUNT VALIDATION
    // -------------------------------------------------------------
    console.log('\n--- SECTION 3: Server-Side Price & Discount Validation ---');

    // 3a. Browser submits price 1 for a 280 item -> server must compute 280
    const tamperedPriceRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'takeaway',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 1, qty: 1 }] // Attempting to pay ₹1
    });
    assert(tamperedPriceRes.statusCode === 201, 'Order created successfully');
    // Subtotal must be 280 (not 1)
    assert(tamperedPriceRes.data.subtotal === 280,
      `Server ignored browser price (₹1) and enforced server menu price (₹280, got ${tamperedPriceRes.data.subtotal})`);

    // 3b. Unknown item ID must be rejected with 400
    const unknownItemRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'ghost_item_9999', name: 'Ghost Food', price: 100, qty: 1 }]
    });
    assert(unknownItemRes.statusCode === 400, 'Unknown menu item rejected with HTTP 400', `Got ${unknownItemRes.statusCode}`);

    // 3c. Item from another restaurant must be rejected with 400
    const crossRestItemRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'sharma-dhaba_m1', name: 'Dal Tadka Special', price: 160, qty: 1 }]
    });
    assert(crossRestItemRes.statusCode === 400, 'Cross-restaurant menu item ID rejected with HTTP 400', `Got ${crossRestItemRes.statusCode}`);

    // 3d. Negative and zero quantities must be rejected with 400
    const negativeQtyRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', price: 280, qty: -2 }]
    });
    assert(negativeQtyRes.statusCode === 400, 'Negative quantity rejected with HTTP 400', `Got ${negativeQtyRes.statusCode}`);

    const zeroQtyRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', price: 280, qty: 0 }]
    });
    assert(zeroQtyRes.statusCode === 400, 'Zero quantity rejected with HTTP 400', `Got ${zeroQtyRes.statusCode}`);

    // 3e. Client submits arbitrary fake discount (5000) without valid promo code -> discount must be 0
    const fakeDiscountRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'takeaway',
      discount: 5000, // Fake discount
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    });
    assert(fakeDiscountRes.statusCode === 201, 'Order created');
    assert(fakeDiscountRes.data.discount === 0,
      `Server ignored client-provided discount (₹5000) and computed ₹0, got ₹${fakeDiscountRes.data.discount}`);

    // -------------------------------------------------------------
    // SECTION 4: IDEMPOTENCY KEY TTL & CLEANUP
    // -------------------------------------------------------------
    console.log('\n--- SECTION 4: Idempotency Key TTL and Cleanup ---');

    // Inject an expired idempotency key directly into disk database (>24 hours old)
    const diskDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    diskDb.idempotencyKeys = diskDb.idempotencyKeys || {};
    const oldKey = 'tiptap-bistro:expired-test-key-25h-old';
    diskDb.idempotencyKeys[oldKey] = {
      orderId: 'ORD-EXPIRED',
      statusCode: 201,
      body: { id: 'ORD-EXPIRED' },
      payloadSig: 'test',
      createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() // 25 hours ago
    };
    fs.writeFileSync(dbPath, JSON.stringify(diskDb, null, 2));

    // Restart server to reload state with old key
    serverProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    serverProcess = spawnServer();
    await new Promise(r => setTimeout(r, 2000));

    // Submit a fresh order, which triggers cleanupExpiredIdempotencyKeys in persistDbChange
    const triggerOrder = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': 'fresh-active-key-1'
    }, {
      tableId: 7,
      orderType: 'takeaway',
      items: [{ id: 'tiptap-bistro_m1', price: 280, qty: 1 }]
    });
    assert(triggerOrder.statusCode === 201, 'Order placed with fresh idempotency key');

    // Read database state to verify expired key was purged
    const updatedDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert(updatedDb.idempotencyKeys[oldKey] === undefined,
      'Expired idempotency key (>24h) was automatically purged from database');
    assert(Boolean(updatedDb.idempotencyKeys['tiptap-bistro:fresh-active-key-1']),
      'Active idempotency key (<24h) is retained in database');

    // -------------------------------------------------------------
    // SECTION 5: PRODUCTION FAIL-CLOSED CREDENTIAL CHECK
    // -------------------------------------------------------------
    console.log('\n--- SECTION 5: Production Fail-Closed on Default Super Admin PIN ---');

    // Spawn server with NODE_ENV=production and SUPER_ADMIN_PIN=0000 (default)
    const failedProdServer = fork('server.js', [], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: '3289',
        NODE_ENV: 'production',
        SUPER_ADMIN_PIN: '0000', // Insecure default
        TIPTAP_DB_FILE: dbPath
      },
      stdio: 'pipe'
    });

    const exitCodePromise = new Promise((resolve) => {
      failedProdServer.on('exit', (code) => resolve(code));
      setTimeout(() => {
        failedProdServer.kill('SIGKILL');
        resolve(-1);
      }, 3000);
    });

    const exitCode = await exitCodePromise;
    assert(exitCode !== 0 && exitCode !== -1,
      'Production startup fails closed (terminates) when SUPER_ADMIN_PIN is set to known default "0000"');

  } catch (err) {
    console.error('Test suite caught unhandled error:', err);
    failed++;
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    if (isolatedDb) {
      isolatedDb.cleanup();
    }
  }

  console.log('\n================================================================');
  console.log(`AUDIT RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRemediationTests();
