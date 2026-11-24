const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3199;
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

async function runRegressionTests() {
  console.log('====================================================');
  console.log('🍽️  TIPTAP REGRESSION TEST: DINER & GUEST WORKFLOWS');
  console.log('====================================================\n');

  const { createIsolatedTestDb } = require('./test-db-helper');
  const { tempDbPath, cleanup } = createIsolatedTestDb('guest-wf');

  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), MONGODB_URI: '', TIPTAP_DB_FILE: tempDbPath },
    stdio: 'pipe'
  });

  serverProc.stderr.on('data', d => console.error('[SERVER ERR]:', d.toString()));
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
    // 0. Ensure normal kitchen flow (rushMode = false)
    await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    }, { rushMode: false });

    // 1. Customer Menu Loading (No Auth Cookie)
    console.log('Step 1: Public Diner Menu Loading (Table 2)');
    const dinerState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro&table=2');
    assert(dinerState.statusCode === 200, 'Customer receives 200 OK for table menu without credentials');
    assert(Array.isArray(dinerState.data.menu) && dinerState.data.menu.length > 0, 'Menu items array is fully populated');
    assert(dinerState.data.restaurant.pin === undefined, 'No restaurant PIN leaked to customer');
    assert(dinerState.data.restaurant.kitchenPin === undefined, 'No kitchen PIN leaked to customer');
    assert(dinerState.data.completedOrders === undefined || dinerState.data.completedOrders.length === 0, 'Other tables completed orders not exposed');

    // 2. Customer Places Order from Table
    console.log('\nStep 2: Customer Order Placement (Table 2)');
    const orderRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 2,
      tableName: 'Table 2',
      items: [
        { id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 2, instructions: 'Medium spicy' },
        { id: 'tiptap-bistro_m5', name: 'Butter Naan', price: 45, qty: 3 }
      ],
      customerPhone: '9876543210',
      customerName: 'Rahul Sharma'
    });
    assert(orderRes.statusCode === 200 || orderRes.statusCode === 201, 'Order placement succeeds (200/201)');
    assert(Boolean(orderRes.data?.id), 'Server returns generated Order ID');

    // 3. Service Call (Call Waiter / Request Water)
    console.log('\nStep 3: Service Request (Call Waiter)');
    const serviceRes = await makeRequest('POST', '/api/service-request?restaurant=tiptap-bistro', {}, {
      tableId: 2,
      tableName: 'Table 2',
      type: 'water',
      message: 'Need 1 bottle of cold water'
    });
    assert(serviceRes.statusCode === 200 || serviceRes.statusCode === 201, 'Customer can request waiter assistance / water');

    // 4. Multi-round KOT (Add item to existing order)
    console.log('\nStep 4: Multi-Round KOT (Add items to active table)');
    const kotRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 2,
      tableName: 'Table 2',
      items: [
        { id: 'tiptap-bistro_m6', name: 'Gulab Jamun (2 Pcs)', price: 90, qty: 1 }
      ]
    });
    assert(kotRes.statusCode === 200 || kotRes.statusCode === 201, 'Multi-round KOT items appended seamlessly');

    console.log('\n====================================================');
    console.log(`🏁 REGRESSION RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('Regression test error:', err);
    process.exit(1);
  } finally {
    serverProc.kill('SIGTERM');
    cleanup();
  }
}

runRegressionTests();
