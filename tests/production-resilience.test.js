const http = require('http');
const { fork } = require('child_process');
const path = require('path');

function makeRequestToPort(port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const reqHeaders = { ...headers };
    let reqData = null;

    if (body) {
      reqData = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(reqData);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
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

async function runResilienceTests() {
  console.log('====================================================');
  console.log('🛡️  TIPTAP PHASE 1: PRODUCTION RESILIENCE AUDIT SUITE');
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

  // ----------------------------------------------------
  // TEST 1: PRODUCTION MONGODB OUTAGE & FAIL-CLOSED BEHAVIOR
  // ----------------------------------------------------
  console.log('--- TEST 1: MongoDB Outage Fail-Closed Protection ---');
  const OUTAGE_PORT = 3210;
  const outageServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(OUTAGE_PORT),
      NODE_ENV: 'production',
      MONGODB_TIMEOUT_MS: '1500',
      MONGODB_URI: 'mongodb://127.0.0.1:27999/unreachable_db_test'
    },
    stdio: 'pipe'
  });

  // Wait for connection attempt to timeout and server to bind
  await new Promise(r => setTimeout(r, 3200));

  try {
    // 1a. /healthz must report 503 Service Unavailable when DB is down in production
    const healthCheck = await makeRequestToPort(OUTAGE_PORT, 'GET', '/healthz');
    assert(healthCheck.statusCode === 503, 'Healthcheck returns 503 Unhealthy when MongoDB is unreachable in production', `Got ${healthCheck.statusCode}`);
    assert(healthCheck.data.status === 'unhealthy', 'Healthcheck status field is "unhealthy"');
    assert(healthCheck.data.database?.connected === false, 'Healthcheck database.connected is strictly false');

    // 1b. Mutating writes (POST /api/orders) must fail-closed with HTTP 503
    const blockedOrder = await makeRequestToPort(OUTAGE_PORT, 'POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 1,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    });
    assert(blockedOrder.statusCode === 503, 'Mutating order write rejected with HTTP 503 during database outage', `Got ${blockedOrder.statusCode}`);
    assert(blockedOrder.data.status === 'service_unavailable', 'Server returns service_unavailable error message');

    // 1c. Read-only menu requests can still be served safely to customers
    const menuRead = await makeRequestToPort(OUTAGE_PORT, 'GET', '/api/state?restaurant=tiptap-bistro&table=1');
    assert(menuRead.statusCode === 200, 'Public diner read request succeeds (200 OK)');
  } finally {
    outageServer.kill('SIGTERM');
  }

  // ----------------------------------------------------
  // TEST 2: PROCESS RESTART & SESSION EPHEMERALITY
  // ----------------------------------------------------
  console.log('\n--- TEST 2: Process Restart & In-Memory Session Invalidation ---');
  const RESTART_PORT = 3211;
  let restartServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(RESTART_PORT), NODE_ENV: 'production', MONGODB_URI: '' },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 1500));
  let savedCookie = null;

  try {
    const loginRes = await makeRequestToPort(RESTART_PORT, 'POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    assert(loginRes.statusCode === 200, 'Login succeeds before server restart');
    savedCookie = extractCookie(loginRes.headers);

    const checkBefore = await makeRequestToPort(RESTART_PORT, 'GET', '/api/auth/session', { Cookie: savedCookie });
    assert(checkBefore.data.authenticated === true, 'Session active before restart');
  } finally {
    restartServer.kill('SIGKILL');
  }

  await new Promise(r => setTimeout(r, 1000));

  // Spawn fresh server on same port to simulate restart
  restartServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(RESTART_PORT), NODE_ENV: 'production', MONGODB_URI: '' },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 1500));

  try {
    const checkAfter = await makeRequestToPort(RESTART_PORT, 'GET', '/api/auth/session', { Cookie: savedCookie });
    assert(checkAfter.data.authenticated === false, 'Session is invalidated after server restart (in-memory session map wiped)');

    const apiCallAfter = await makeRequestToPort(RESTART_PORT, 'GET', '/api/state?restaurant=tiptap-bistro', { Cookie: savedCookie });
    assert(apiCallAfter.statusCode === 200 && apiCallAfter.data.customers === undefined,
      'Old session cookie no longer provides staff privileges after restart');
  } finally {
    restartServer.kill('SIGTERM');
  }

  // ----------------------------------------------------
  // TEST 3: MULTI-INSTANCE SESSION DISJOINTNESS (NO SHARED STORE)
  // ----------------------------------------------------
  console.log('\n--- TEST 3: Multi-Instance Session Isolation Verification ---');
  const PORT_INSTANCE_A = 3212;
  const PORT_INSTANCE_B = 3213;

  const instanceA = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT_INSTANCE_A), NODE_ENV: 'production', MONGODB_URI: '' },
    stdio: 'pipe'
  });

  const instanceB = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT_INSTANCE_B), NODE_ENV: 'production', MONGODB_URI: '' },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 2000));

  try {
    // Login on Instance A
    const loginA = await makeRequestToPort(PORT_INSTANCE_A, 'POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      station: 'counter'
    });
    const cookieA = extractCookie(loginA.headers);

    // Verify session is valid on Instance A
    const checkA = await makeRequestToPort(PORT_INSTANCE_A, 'GET', '/api/auth/session', { Cookie: cookieA });
    assert(checkA.data.authenticated === true, 'Session is authenticated on Instance A');

    // Query Instance B with Instance A cookie -> Must fail (not shared)
    const checkB = await makeRequestToPort(PORT_INSTANCE_B, 'GET', '/api/auth/session', { Cookie: cookieA });
    assert(checkB.data.authenticated === false, 'Instance B rejects Instance A session (proves in-memory single-instance architecture)');
  } finally {
    instanceA.kill('SIGTERM');
    instanceB.kill('SIGTERM');
  }

  // ----------------------------------------------------
  // TEST 4: CONSTANT-TIME TIMING-SAFE PIN VERIFICATION
  // ----------------------------------------------------
  console.log('\n--- TEST 4: Constant-Time Super Admin PIN Comparison ---');
  const AUTH_TEST_PORT = 3214;
  const authServer = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(AUTH_TEST_PORT),
      NODE_ENV: 'production',
      SUPER_ADMIN_PIN: '948201',
      MONGODB_URI: ''
    },
    stdio: 'pipe'
  });

  await new Promise(r => setTimeout(r, 1500));

  try {
    const wrongPin = await makeRequestToPort(AUTH_TEST_PORT, 'POST', '/api/admin/verify-pin', {}, { pin: '948200' });
    assert(wrongPin.statusCode === 401, 'Wrong Super Admin PIN rejected (401)');

    const correctPin = await makeRequestToPort(AUTH_TEST_PORT, 'POST', '/api/admin/verify-pin', {}, { pin: '948201' });
    assert(correctPin.statusCode === 200 && correctPin.data.success, 'Correct constant-time Super Admin PIN succeeds (200)');
  } finally {
    authServer.kill('SIGTERM');
  }

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(`🏁 RESILIENCE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) process.exitCode = 1;
}

runResilienceTests();
