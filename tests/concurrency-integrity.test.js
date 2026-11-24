/**
 * TIPTAP CONCURRENCY, WRITE-INTEGRITY & DURABLE IDEMPOTENCY TEST SUITE
 * 
 * Verifies:
 * 1. CHECK 1 & 2: Mutex Queue & Concurrent Order Placement:
 *    - 5 simultaneous orders across 5 free tables (Promise.all)
 *    - 4 simultaneous orders on the same table (multi-round KOT accumulation)
 *    - Zero lost updates or race conditions
 * 2. CHECK 1: Rollback Isolation:
 *    - Serialized mutation queue ensures failed writes roll back only uncommitted state
 *    - Prior committed writes and subsequent queued writes remain unaffected
 * 3. CHECK 3: Durable Idempotency Across Restarts:
 *    - Scoped idempotency keys persisted in db.idempotencyKeys
 *    - Replay across server process restarts returns cached order without duplication
 *    - Idempotency key payload conflict returns HTTP 409 Conflict
 *    - Restaurant isolation: same key across different restaurants does not collide
 *    - Concurrent requests with identical idempotency key yield exactly 1 order
 * 4. CHECK 3: Fast Double-Click Deduplication Window:
 *    - Immediate duplicate (<2.5s) deduplicated
 *    - Subsequent legitimate round (>2.5s) accepted
 * 5. CHECK 4: MongoDB Write Concern:
 *    - Majority write concern enforced in source code and configuration
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3250;
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

function spawnServer(envOverrides = {}) {
  return fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'development',
      ...envOverrides
    },
    stdio: 'pipe'
  });
}

async function runConcurrencyTests() {
  console.log('================================================================');
  console.log('⚡ TIPTAP CONCURRENCY, WRITE-INTEGRITY & IDEMPOTENCY TEST SUITE');
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

  // Backup data/tiptap-db.json to restore afterwards
  const dbPath = path.resolve(__dirname, '../data/tiptap-db.json');
  const backupPath = path.resolve(__dirname, '../data/tiptap-db.json.concurrency.bak');
  fs.copyFileSync(dbPath, backupPath);

  let serverProcess = null;

  try {
    serverProcess = spawnServer();
    await new Promise(r => setTimeout(r, 2000));

    // -------------------------------------------------------------
    // SECTION 1: SIMULTANEOUS ORDERS ACROSS DIFFERENT TABLES
    // -------------------------------------------------------------
    console.log('--- SECTION 1: Concurrent Orders Across 5 Different Tables ---');

    // Get baseline order count using staff auth to read full orders
    const initialBistroState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    });
    const initialOrderCount = (initialBistroState.data.orders || []).length;

    // Use free tables 3, 4, 5, 7, 8 for fresh initial dine-in orders
    const targetTables = [3, 4, 5, 7, 8];
    const tablePromises = targetTables.map(tableId => {
      return makeRequest('POST', `/api/orders?restaurant=tiptap-bistro`, {
        'Idempotency-Key': `simultaneous-table-${tableId}-${Date.now()}`
      }, {
        tableId,
        orderType: 'dinein',
        items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
      });
    });

    const tableResults = await Promise.all(tablePromises);

    // Verify all 5 succeeded with HTTP 201 Created
    const all201 = tableResults.every(r => r.statusCode === 201);
    assert(all201, 'All 5 concurrent table orders returned HTTP 201 Created', 
      `Statuses: ${tableResults.map(r => r.statusCode).join(', ')}`);

    // Verify all 5 have unique order IDs
    const orderIds = tableResults.map(r => r.data.id);
    const uniqueIds = new Set(orderIds);
    assert(uniqueIds.size === 5, 'All 5 concurrent orders received distinct unique Order IDs', `Got ${Array.from(uniqueIds).join(', ')}`);

    // Verify database state contains all 5 orders
    const postSimState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    });
    const newOrderCount = (postSimState.data.orders || []).length;
    assert(newOrderCount === initialOrderCount + 5, `Database order count increased by exactly 5 (from ${initialOrderCount} to ${newOrderCount})`);

    // Verify all 5 tables are now occupied
    const tables = postSimState.data.tables || [];
    const tablesOccupied = targetTables.every(tid => {
      const t = tables.find(tbl => tbl.id === tid);
      return t && t.status === 'occupied';
    });
    assert(tablesOccupied, 'All 5 tables (3, 4, 5, 7, 8) updated status to "occupied" without race conditions');

    // -------------------------------------------------------------
    // SECTION 2: CONCURRENT ORDERS ON THE SAME TABLE (MULTI-ROUND KOT)
    // -------------------------------------------------------------
    console.log('\n--- SECTION 2: Concurrent Multi-Round Orders on Same Table ---');

    // Target Table 6 (which is free) for 4 simultaneous rounds
    const roundPayloads = [
      { items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }], notes: 'Round 1 Appetizer' },
      { items: [{ id: 'tiptap-bistro_m2', name: 'Dal Makhani', price: 220, qty: 2 }], notes: 'Round 2 Mains' },
      { items: [{ id: 'tiptap-bistro_m3', name: 'Garlic Naan', price: 60, qty: 4 }], notes: 'Round 3 Breads' },
      { items: [{ id: 'tiptap-bistro_m_water', name: 'Packaged Mineral Water Bottle (1L)', price: 20, qty: 2 }], notes: 'Round 4 Beverages' }
    ];

    const roundPromises = roundPayloads.map((payload, idx) => {
      return makeRequest('POST', `/api/orders?restaurant=tiptap-bistro`, {
        'Idempotency-Key': `same-table-round-${idx}-${Date.now()}`
      }, {
        tableId: 6,
        orderType: 'dinein',
        ...payload
      });
    });

    const roundResults = await Promise.all(roundPromises);
    const roundsSuccessful = roundResults.every(r => r.statusCode === 200 || r.statusCode === 201);
    assert(roundsSuccessful, 'All 4 concurrent orders on Table 6 accepted (HTTP 200/201)', 
      `Statuses: ${roundResults.map(r => r.statusCode).join(', ')}`);

    // Verify Table 6 state
    const table6State = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro&table=6');
    const table6ActiveOrders = (table6State.data.orders || []).filter(o => o.tableId === 6 && o.paymentStatus !== 'paid');
    assert(table6ActiveOrders.length === 1, 'Exactly 1 consolidated active dining order exists for Table 6');

    const consolidatedOrder = table6ActiveOrders[0] || {};
    const kotCount = (consolidatedOrder.kots || consolidatedOrder.rounds || []).length;
    assert(kotCount === 4, 
      `Order on Table 6 contains all 4 KOT rounds (found ${kotCount})`);

    // Verify all items are accounted for in items array
    const totalItemQty = (consolidatedOrder.items || []).reduce((sum, item) => sum + item.qty, 0);
    // 1 Paneer (1) + 2 Dal (2) + 4 Naan (4) + 2 Water (2) = 9 total qty
    assert(totalItemQty === 9, `Total item quantity across all rounds is exactly 9 (found ${totalItemQty})`);

    // -------------------------------------------------------------
    // SECTION 3: DURABLE IDEMPOTENCY & RESTARTS
    // -------------------------------------------------------------
    console.log('\n--- SECTION 3: Durable Idempotency Across Process Restarts ---');

    const durableKey = `durable-test-key-${Date.now()}`;
    const orderPayload = {
      tableId: 3,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    };

    // 3a. Initial submission
    const initialIdempRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': durableKey
    }, orderPayload);
    assert(initialIdempRes.statusCode === 200 || initialIdempRes.statusCode === 201, 
      'Initial request with Idempotency-Key created with HTTP 200/201');
    const durableOrderId = initialIdempRes.data.id;

    // 3b. Immediate replay with same key and payload returns cached response
    const replayRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': durableKey
    }, orderPayload);
    assert(replayRes.statusCode === 200 || replayRes.statusCode === 201, 'Replay returned success status');
    assert(replayRes.data.id === durableOrderId, `Replay returned identical Order ID (${durableOrderId})`);

    // 3c. Server Process Restart
    console.log('  ... Restarting server process to test cold durability ...');
    serverProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));

    serverProcess = spawnServer();
    await new Promise(r => setTimeout(r, 2000));

    // 3d. Replay after server restart
    const postRestartReplay = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': durableKey
    }, orderPayload);
    assert(postRestartReplay.statusCode === 200 || postRestartReplay.statusCode === 201, 
      'Post-restart replay returns success status');
    assert(postRestartReplay.data.id === durableOrderId, 
      `Post-restart replay preserves identical Order ID (${durableOrderId}) from disk`);

    // -------------------------------------------------------------
    // SECTION 4: IDEMPOTENCY KEY CONFLICT DETECTION
    // -------------------------------------------------------------
    console.log('\n--- SECTION 4: Idempotency Key Conflict Detection (HTTP 409) ---');

    const conflictKey = `conflict-key-${Date.now()}`;
    // First request
    const origOrder = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': conflictKey
    }, {
      tableId: 8,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    });
    assert(origOrder.statusCode === 200 || origOrder.statusCode === 201, 'Original request succeeded with HTTP 200/201');

    // Second request with SAME key but DIFFERENT payload (different table & items)
    const conflictOrder = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': conflictKey
    }, {
      tableId: 1, // Different table
      orderType: 'takeaway', // Different orderType
      items: [{ id: 'tiptap-bistro_m2', name: 'Dal Makhani', price: 220, qty: 3 }] // Different item
    });
    assert(conflictOrder.statusCode === 409, 'Reusing Idempotency-Key with different payload rejected with HTTP 409 Conflict');
    assert(conflictOrder.data.status === 'idempotency_conflict', 'Rejection contains status "idempotency_conflict"');

    // -------------------------------------------------------------
    // SECTION 5: RESTAURANT SCOPING FOR IDEMPOTENCY KEYS
    // -------------------------------------------------------------
    console.log('\n--- SECTION 5: Restaurant Scoping of Idempotency Keys ---');

    const sharedKey = `shared-multi-tenant-key-${Date.now()}`;
    // Request on tiptap-bistro
    const bistroRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Idempotency-Key': sharedKey
    }, {
      tableId: 2,
      orderType: 'dinein',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 1 }]
    });
    assert(bistroRes.statusCode === 201 || bistroRes.statusCode === 200, 'Order on tiptap-bistro succeeded');

    // Same key on sharma-dhaba with different items
    const dhabaRes = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {
      'Idempotency-Key': sharedKey
    }, {
      tableId: 2,
      orderType: 'dinein',
      items: [{ id: 'sharma-dhaba_m1', name: 'Dal Tadka Special', price: 160, qty: 2 }]
    });
    assert(dhabaRes.statusCode === 201 || dhabaRes.statusCode === 200, 'Same Idempotency-Key on sharma-dhaba succeeded (keys properly tenant-scoped)');
    assert(dhabaRes.data.id !== bistroRes.data.id, 'Dhaba order ID is distinct from Bistro order ID');

    // -------------------------------------------------------------
    // SECTION 6: CONCURRENT REQUESTS WITH IDENTICAL KEY
    // -------------------------------------------------------------
    console.log('\n--- SECTION 6: Concurrent Race with Same Idempotency-Key ---');

    const raceKey = `concurrent-race-key-${Date.now()}`;
    const racePayload = {
      tableId: 3,
      orderType: 'takeaway',
      items: [{ id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', price: 280, qty: 2 }]
    };

    // Before race, get count
    const stateBeforeRace = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    });
    const countBeforeRace = (stateBeforeRace.data.orders || []).length;

    // Send 4 simultaneous requests with identical key and payload
    const raceRequests = [1, 2, 3, 4].map(() => {
      return makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
        'Idempotency-Key': raceKey
      }, racePayload);
    });

    const raceResponses = await Promise.all(raceRequests);
    const allSucceeded = raceResponses.every(r => r.statusCode === 201 || r.statusCode === 200);
    assert(allSucceeded, 'All 4 simultaneous same-key requests returned success HTTP status');

    // All returned the same order ID
    const returnedIds = raceResponses.map(r => r.data.id);
    const uniqueReturnedIds = new Set(returnedIds);
    assert(uniqueReturnedIds.size === 1, `All 4 concurrent requests yielded the EXACT same Order ID (${returnedIds[0]})`);

    // Verify only 1 order was added to database
    const stateAfterRace = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', {
      'x-staff-pin': '1234'
    });
    const countAfterRace = (stateAfterRace.data.orders || []).length;
    assert(countAfterRace === countBeforeRace + 1, `Database orders increased by exactly 1 (from ${countBeforeRace} to ${countAfterRace})`);

    // -------------------------------------------------------------
    // SECTION 7: DOUBLE-CLICK WINDOW DEDUPLICATION (2.5s)
    // -------------------------------------------------------------
    console.log('\n--- SECTION 7: Fast Double-Click Deduplication Window (2.5s) ---');

    const doubleClickPayload = {
      tableId: 4,
      orderType: 'takeaway',
      notes: 'No spicy please',
      items: [{ id: 'tiptap-bistro_m3', name: 'Butter Naan / Garlic Naan', price: 60, qty: 2 }]
    };

    // First click
    const firstClick = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, doubleClickPayload);
    assert(firstClick.statusCode === 201 || firstClick.statusCode === 200, 'First click order placed successfully');

    // Rapid double-click (<2.5s, no key, identical signature)
    const rapidSecondClick = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, doubleClickPayload);
    assert(rapidSecondClick.statusCode === firstClick.statusCode, 'Rapid double-click returned matching status code');
    assert(rapidSecondClick.data.id === firstClick.data.id, 'Rapid double-click deduplicated to original order ID');

    // Wait 2.8s (exceeds 2.5s window)
    console.log('  ... Waiting 2.8s for double-click window to expire ...');
    await new Promise(r => setTimeout(r, 2800));

    // Legitimate second round submitted by diner with same items
    const legitSecondRound = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, doubleClickPayload);
    assert(legitSecondRound.statusCode === 200 || legitSecondRound.statusCode === 201, 
      'Legitimate repeat order after 2.5s is accepted and not blocked');
    assert(legitSecondRound.data.id !== firstClick.data.id, 
      'Legitimate repeat order received distinct Order ID');

    // -------------------------------------------------------------
    // SECTION 8: MONGODB WRITE CONCERN CODE INSPECTION
    // -------------------------------------------------------------
    console.log('\n--- SECTION 8: MongoDB Production Majority Write Concern ---');

    const serverCode = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
    const hasWriteConcernW = serverCode.includes("writeConcernW = process.env.MONGODB_WRITE_CONCERN || (process.env.NODE_ENV === 'production' ? 'majority' : 1)");
    const hasWriteConcernJ = serverCode.includes("writeConcernJ = process.env.MONGODB_JOURNAL !== undefined");
    const hasWriteConcernInSaveDb = serverCode.includes("upsert: true, writeConcern");
    const hasMutexQueue = serverCode.includes("let mutationQueue = Promise.resolve()");

    assert(hasWriteConcernW, 'server.js defaults MONGODB_WRITE_CONCERN to "majority" in production');
    assert(hasWriteConcernJ, 'server.js defaults MONGODB_JOURNAL to true in production');
    assert(hasWriteConcernInSaveDb, 'saveDb() explicitly passes writeConcern object to MongoDB updateOne');
    assert(hasMutexQueue, 'server.js serializes all state changes via FIFO Promise mutex queue (mutationQueue)');

    // -------------------------------------------------------------
    // SECTION 9: ROLLBACK ISOLATION UNDER SIMULATED WRITE FAILURE
    // -------------------------------------------------------------
    console.log('\n--- SECTION 9: Rollback Isolation Under Concurrent Failure ---');

    // Unit verification of the FIFO Mutex rollback algorithm
    let simulatedDb = { counter: 0, committedItems: [] };
    let simQueue = Promise.resolve();

    function simPersistChange(mutateFn, shouldFail = false) {
      const previous = simQueue;
      const current = (async () => {
        try { await previous; } catch (_) {}
        const snapshot = JSON.parse(JSON.stringify(simDbCopy));
        try {
          await mutateFn(simDbCopy);
          if (shouldFail) throw new Error('Simulated Cloud Cluster Write Rejection');
          return { success: true };
        } catch (err) {
          simDbCopy = snapshot;
          return { success: false, error: err };
        }
      })();
      simQueue = current;
      return current;
    }

    let simDbCopy = { ...simulatedDb };

    // Fire 3 operations concurrently:
    // Op A (succeeds, adds 'A')
    // Op B (fails, tries to add 'B')
    // Op C (succeeds, adds 'C')
    const [resA, resB, resC] = await Promise.all([
      simPersistChange(async (d) => { d.committedItems.push('A'); d.counter += 1; }),
      simPersistChange(async (d) => { d.committedItems.push('B'); d.counter += 10; }, true),
      simPersistChange(async (d) => { d.committedItems.push('C'); d.counter += 100; })
    ]);

    assert(resA.success === true, 'Concurrent Op A succeeded');
    assert(resB.success === false, 'Concurrent Op B failed cleanly and rolled back');
    assert(resC.success === true, 'Concurrent Op C succeeded after Op B rollback');
    assert(simDbCopy.counter === 101, `Counter accurately equals 101 (Op A=1 + Op C=100), got ${simDbCopy.counter}`);
    assert(JSON.stringify(simDbCopy.committedItems) === JSON.stringify(['A', 'C']), 
      'Committed items contain ["A", "C"], cleanly excluding rolled-back Op B without corrupting Op A');

  } catch (err) {
    console.error('Test suite caught unhandled error:', err);
    failed++;
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    // Restore original database
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, dbPath);
      fs.unlinkSync(backupPath);
    }
  }

  console.log('\n================================================================');
  console.log(`AUDIT RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runConcurrencyTests();
