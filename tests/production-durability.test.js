/**
 * TIPTAP PRODUCTION DURABILITY & WRITE ACKNOWLEDGEMENT TEST SUITE
 * 
 * Verifies:
 * 1. CHECK 1: Missing MONGODB_URI in production enforces fail-closed state:
 *    - /healthz returns 503 Unhealthy
 *    - Mutating writes (POST /api/orders, POST /api/settings) return 503
 *    - data/tiptap-db.json is NEVER modified
 * 2. CHECK 2: Write Durability & Idempotency:
 *    - Mutating requests await database acknowledgement before HTTP success
 *    - Database failures do not return false success and rollback in-memory state
 *    - Disconnected database blocks all mutations
 *    - Duplicate requests (Idempotency-Key & rapid double-click) do not create duplicate orders
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

process.env.SUPER_ADMIN_PIN = process.env.SUPER_ADMIN_PIN || 'ProdSecr3t#991';

function makeRequest(port, method, pathStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: pathStr,
      method,
      headers: { ...headers }
    };

    let postData = null;
    if (body) {
      postData = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { data = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, data, raw });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runDurabilityAudit() {
  console.log('====================================================');
  console.log('🛡️  TIPTAP PRODUCTION DURABILITY & WRITE AUDIT SUITE');
  console.log('====================================================\n');

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

  const { createIsolatedTestDb } = require('./test-db-helper');
  const { tempDbPath, cleanup } = createIsolatedTestDb('durability');
  const initialDbRaw = fs.readFileSync(tempDbPath, 'utf8');

  // =========================================================================
  // TEST SECTION 1: CHECK 1 — MISSING MONGODB_URI IN PRODUCTION
  // =========================================================================
  console.log('--- SECTION 1: Missing MONGODB_URI in Production Mode ---');
  const PORT_MISSING_URI = 3220;
  const missingUriServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT_MISSING_URI),
      NODE_ENV: 'production',
      MONGODB_URI: '', // explicitly unset
      TIPTAP_DB_FILE: tempDbPath
    },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 1800));

  try {
    // 1a. /healthz must return 503 Unhealthy
    const health = await makeRequest(PORT_MISSING_URI, 'GET', '/healthz');
    assert(health.statusCode === 503, 'Healthcheck returns HTTP 503 when MONGODB_URI is missing in production', `Got ${health.statusCode}`);
    assert(health.data.status === 'unhealthy', 'Healthcheck status field is "unhealthy"');
    assert(health.data.database?.connected === false, 'Healthcheck database.connected is strictly false');
    assert(health.data.database?.mode === 'cloud-missing', 'Healthcheck reports database.mode as "cloud-missing"');

    // 1b. Customer Order creation (POST /api/orders) must be rejected with HTTP 503
    const orderRes = await makeRequest(PORT_MISSING_URI, 'POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 3,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    });
    assert(orderRes.statusCode === 503, 'Mutating order placement rejected with HTTP 503 when MONGODB_URI is missing', `Got ${orderRes.statusCode}`);
    assert(orderRes.data.status === 'service_unavailable', 'Order rejection contains status "service_unavailable"');

    // 1c. Restaurant Settings update (POST /api/settings) must be rejected with HTTP 503
    const settingsRes = await makeRequest(PORT_MISSING_URI, 'POST', '/api/settings?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    }, { name: 'Attempted Unpersisted Name Change' });
    assert(settingsRes.statusCode === 503, 'Settings mutation rejected with HTTP 503 when MONGODB_URI is missing', `Got ${settingsRes.statusCode}`);

    // 1d. Customer Read-Only menu query succeeds (200 OK) so diners can view menu
    const menuRes = await makeRequest(PORT_MISSING_URI, 'GET', '/api/state?restaurant=tiptap-bistro&table=3');
    assert(menuRes.statusCode === 200, 'Public diner read request succeeds without error');

    // 1e. Verify isolated database was NOT modified in production
    const currentDbRaw = fs.readFileSync(tempDbPath, 'utf8');
    assert(currentDbRaw === initialDbRaw, 'Isolated database was NOT modified (silent ephemeral write prevented)');
  } finally {
    missingUriServer.kill('SIGTERM');
  }

  await new Promise(r => setTimeout(r, 1000));

  // =========================================================================
  // TEST SECTION 2: CHECK 2 — WRITE DURABILITY, TIMEOUT & ROLLBACK ON FAILURE
  // =========================================================================
  console.log('\n--- SECTION 2: Cloud Outage & Rollback Protection ---');
  const PORT_OUTAGE = 3221;
  const outageServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT_OUTAGE),
      NODE_ENV: 'production',
      MONGODB_TIMEOUT_MS: '1200',
      MONGODB_URI: 'mongodb://127.0.0.1:27999/unreachable_db', // guaranteed unreachable port
      TIPTAP_DB_FILE: tempDbPath
    },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 2600));

  try {
    // 2a. State before attempted order placement: Table 4 should be free
    const stateBefore = await makeRequest(PORT_OUTAGE, 'GET', '/api/state?restaurant=tiptap-bistro&table=4');
    const tableBefore = stateBefore.data.tables.find(t => t.id === 4);
    assert(tableBefore.status === 'free', 'Table 4 is initially free before order');

    // 2b. Attempt to place order during database outage -> MUST FAIL with 503
    const orderFail = await makeRequest(PORT_OUTAGE, 'POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 4,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m2', name: 'Dal Makhani', price: 240, qty: 1 }]
    });
    assert(orderFail.statusCode === 503, 'Order placement rejected with HTTP 503 during database outage', `Got ${orderFail.statusCode}`);
    assert(orderFail.data.status === 'service_unavailable', 'Failure response does NOT claim false success');

    // 2c. Verify in-memory state rollback: Table 4 must remain free, NOT occupied!
    const stateAfter = await makeRequest(PORT_OUTAGE, 'GET', '/api/state?restaurant=tiptap-bistro&table=4');
    const tableAfter = stateAfter.data.tables.find(t => t.id === 4);
    assert(tableAfter.status === 'free', 'Table 4 remained free (in-memory state was rolled back after failed write)');
    assert(stateAfter.data.orders.length === 0, 'Zero phantom orders exist in memory after write failure');
  } finally {
    outageServer.kill('SIGTERM');
  }

  await new Promise(r => setTimeout(r, 1000));

  // =========================================================================
  // TEST SECTION 3: CHECK 2 — ORDER IDEMPOTENCY & DEDUPLICATION
  // =========================================================================
  console.log('\n--- SECTION 3: Order Idempotency & Deduplication ---');
  const PORT_IDEMP = 3222;
  const idempServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT_IDEMP),
      NODE_ENV: 'test',
      MONGODB_URI: '',
      TIPTAP_DB_FILE: tempDbPath
    },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 1600));

  try {
    // 3a. First request with Idempotency-Key
    const idempKey = `test-idemp-${Date.now()}`;
    const order1 = await makeRequest(PORT_IDEMP, 'POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': idempKey
    }, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }],
      notes: 'No spicy'
    });
    assert(order1.statusCode === 201, 'First order with Idempotency-Key succeeds (201 Created)');
    const createdOrderId = order1.data.id;
    assert(Boolean(createdOrderId), `Received order ID: ${createdOrderId}`);

    // 3b. Duplicate request with identical Idempotency-Key -> MUST return existing order!
    const order2 = await makeRequest(PORT_IDEMP, 'POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': idempKey
    }, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }],
      notes: 'No spicy'
    });
    assert(order2.statusCode === 201 || order2.statusCode === 200, 'Duplicate idempotency request returns success');
    assert(order2.data.id === createdOrderId, 'Duplicate request returned exact same Order ID (no duplicate created)');

    // 3c. Verify Table 5 only has ONE active order with 1 item, NOT 2 items!
    const stateCheck = await makeRequest(PORT_IDEMP, 'GET', '/api/state?restaurant=tiptap-bistro&table=5');
    const table5Orders = stateCheck.data.orders.filter(o => o.tableId === 5);
    assert(table5Orders.length === 1, 'Table 5 has exactly 1 order in active list');
    assert(table5Orders[0].items.length === 1, 'Order has exactly 1 item (duplicate items were not appended)');

    // 3d. Rapid double-click without Idempotency-Key (simulating diner double tapping button)
    const rapidPayload = {
      tableId: 6,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m3', name: 'Butter Naan', price: 60, qty: 2 }],
      notes: 'Extra crisp'
    };
    const [rapid1, rapid2] = await Promise.all([
      makeRequest(PORT_IDEMP, 'POST', '/api/orders?restaurant=tiptap-bistro', {}, rapidPayload),
      makeRequest(PORT_IDEMP, 'POST', '/api/orders?restaurant=tiptap-bistro', {}, rapidPayload)
    ]);

    assert(rapid1.statusCode === 201 || rapid1.statusCode === 200, 'Rapid request 1 succeeds');
    assert(rapid2.statusCode === 201 || rapid2.statusCode === 200, 'Rapid request 2 succeeds');
    assert(rapid1.data.id === rapid2.data.id, 'Rapid duplicate requests returned same Order ID');

    // 3e. Multi-Round KOT ordering works when ordering a distinct new item
    const round2Res = await makeRequest(PORT_IDEMP, 'POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m3', name: 'Butter Naan', price: 60, qty: 3 }],
      notes: 'Round 2 breads'
    });
    assert(round2Res.statusCode === 200, 'Legitimate second round KOT succeeds (200 OK)');
    assert(round2Res.data.isMultiRound === true, 'Order marked as multi-round');
    assert(round2Res.data.currentKotNumber === 2, 'KOT round number incremented to 2');
  } finally {
    idempServer.kill('SIGTERM');
    cleanup();
  }

  console.log('\n====================================================');
  console.log(`🏁 DURABILITY RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runDurabilityAudit().catch(err => {
  console.error('Fatal durability test error:', err);
  process.exit(1);
});
