/**
 * TipTap Phase 10: Automated Real-Time Payment Verification Test Suite
 *
 * Comprehensive Security & Remediation Verifications:
 * 1. Fail-closed Razorpay order creation (production mode missing credentials rejection)
 * 2. Razorpay order binding to local order
 * 3. Webhook HMAC-SHA256 signature verification (rejection of unsigned/forged/tampered payloads)
 * 4. Webhook replay event deduplication (x-razorpay-event-id) and payment ID deduplication
 * 5. Webhook amount (paise) and currency (INR) validation
 * 6. Handling of payment.captured, order.paid, and payment.failed events
 * 7. Provider payment status verification (GET /v1/payments/:id - captured required)
 * 8. Authorized-only and failed payment rejection during Checkout verification
 * 9. Provider timeout/failure handling without false settlement
 * 10. Direct Client Checkout signature verification (/api/payment/verify-signature)
 * 11. Cross-tenant payment rejection and order ownership binding
 * 12. Concurrency: concurrent webhook deliveries & checkout callback race prevention
 * 13. Shared atomic, idempotent payment settlement service
 * 14. Customer UI verification (zero manual UTR inputs, accurate labels)
 * 15. Database isolation (zero disk baseline mutations)
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createIsolatedTestDb } = require('./test-db-helper');

const TEST_PORT = 3297;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const TEST_RAZORPAY_KEY_ID = 'rzp_test_TipTapPhase10Key';
const TEST_RAZORPAY_KEY_SECRET = 'Phase10Secr3tKey#Razorpay';
const TEST_RAZORPAY_WEBHOOK_SECRET = 'WebhookSecr3t#Phase10Verify';

function makeRequest(method, urlPath, headers = {}, body = null, port = TEST_PORT) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
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

function computeWebhookSignature(rawBody, secret = TEST_RAZORPAY_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function computeCheckoutSignature(orderId, paymentId, secret = TEST_RAZORPAY_KEY_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

async function runPhase10Tests() {
  console.log('================================================================');
  console.log('🛡️  TIPTAP PHASE 10: AUTOMATIC PAYMENT VERIFICATION TEST SUITE');
  console.log('================================================================\n');

  const { tempDbPath, cleanup, getInitialRaw } = createIsolatedTestDb('phase10-payment');
  const initialHash = crypto.createHash('sha256').update(getInitialRaw()).digest('hex');

  // Seed dedicated test tables 91-100 for Section 9k and Section 11 in isolated temporary database
  const tempDbObj = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
  for (let tid = 91; tid <= 100; tid++) {
    if (!tempDbObj.restaurants['tiptap-bistro'].tables.find(t => t.id === tid)) {
      tempDbObj.restaurants['tiptap-bistro'].tables.push({
        id: tid,
        name: `Table ${tid}`,
        status: 'free',
        currentOrderId: null,
        seatingTime: null
      });
    }
  }
  fs.writeFileSync(tempDbPath, JSON.stringify(tempDbObj, null, 2));

  // Spawn main test server in test mode
  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      MONGODB_URI: '',
      TIPTAP_DB_FILE: tempDbPath,
      RAZORPAY_KEY_ID: TEST_RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_RAZORPAY_KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: TEST_RAZORPAY_WEBHOOK_SECRET,
      SUPER_ADMIN_PIN: 'SuperAdminPin#Phase10'
    },
    stdio: 'pipe'
  });

  serverProc.stderr.on('data', d => console.error('[SERVER LOG]:', d.toString()));

  await new Promise(r => setTimeout(r, 2000));

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ [PASS]: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL]: ${testName}`);
      failed++;
    }
  }

  try {
    // ----------------------------------------------------
    // SECTION 1: ORDER CREATION & RAZORPAY ORDER BINDING
    // ----------------------------------------------------
    console.log('--- 1. ORDER CREATION & RAZORPAY ORDER BINDING ---');
    const orderRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 4,
      tableName: 'Table 4',
      customerPhone: '9876543210',
      items: [
        { id: 'tiptap-bistro_m1', name: 'Paneer Butter Masala', qty: 2 } // 280 * 2 = 560 + 5% GST (28) = 588
      ]
    });
    assert(orderRes.statusCode === 201, 'Dine-in order placed successfully (HTTP 201)');
    const orderId = orderRes.data.id;
    const expectedTotal = orderRes.data.total; // 588
    const expectedPaise = Math.round(expectedTotal * 100); // 58800

    const paymentOrderRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, {
      orderId
    });
    assert(paymentOrderRes.statusCode === 200, 'Payment order created (HTTP 200)');
    assert(Boolean(paymentOrderRes.data.razorpayOrderId), 'Server generated authentic razorpayOrderId');
    assert(paymentOrderRes.data.amountPaise === expectedPaise, `Amount in paise matches order total (${expectedPaise})`);
    const rzpOrderId = paymentOrderRes.data.razorpayOrderId;

    // Verify razorpayOrderId is bound to local order
    const stateCheck = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderId}`);
    const localOrder = (stateCheck.data.orders || []).find(o => o.id === orderId);
    assert(localOrder && localOrder.razorpayOrderId === rzpOrderId, 'Local order document securely binds razorpayOrderId');

    // 1b. Order-Binding Persistence Failure Hardening
    console.log('\n--- 1b. ORDER-BINDING PERSISTENCE FAILURE SIMULATION ---');
    const orderFailPersistRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 6,
      tableName: 'Table 6',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const failOrderId = orderFailPersistRes.data.id;

    // Attempt to create payment order with simulated persistence failure
    const persistFailRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, {
      orderId: failOrderId,
      simulatePersistFailure: true
    });
    assert(persistFailRes.statusCode === 500, 'Database persistence failure returns HTTP 500');
    assert(persistFailRes.data.code === 'PERSISTENCE_FAILED', 'Persistence failure returns code "PERSISTENCE_FAILED"');
    assert(!persistFailRes.data.razorpayOrderId, 'Never returns a usable razorpayOrderId to client on persistence failure');

    // Verify order remains unbound in memory and state
    const checkUnboundState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${failOrderId}`);
    const unboundOrdDoc = (checkUnboundState.data.orders || []).find(o => o.id === failOrderId);
    assert(unboundOrdDoc && !unboundOrdDoc.razorpayOrderId, 'Failed order persistence rolls back and leaves order unbound without razorpayOrderId');

    // ----------------------------------------------------
    // SECTION 2: FAIL-CLOSED ORDER CREATION IN PRODUCTION
    // ----------------------------------------------------
    console.log('\n--- 2. FAIL-CLOSED PRODUCTION ORDER CREATION ---');
    // Test production fail-closed in a separate child process with production mode & missing credentials
    const PROD_TEST_PORT = 3299;
    const { tempDbPath: prodDbPath, cleanup: prodCleanup } = createIsolatedTestDb('phase10-prod-failclosed');
    const prodProc = fork('server.js', [], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PROD_TEST_PORT),
        NODE_ENV: 'production',
        MONGODB_URI: '',
        TIPTAP_DB_FILE: prodDbPath,
        RAZORPAY_KEY_ID: '', // Missing credentials
        RAZORPAY_KEY_SECRET: '',
        RAZORPAY_WEBHOOK_SECRET: '',
        SUPER_ADMIN_PIN: 'ProdSuperAdmin#123',
        TIPTAP_TEST_ALLOW_MUTATIONS: 'true'
      },
      stdio: 'pipe'
    });
    prodProc.stderr.on('data', d => console.error('[PROD TEST LOG]:', d.toString()));
    await new Promise(r => setTimeout(r, 2000));

    try {
      const prodOrder = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
        tableId: 5,
        tableName: 'Table 5',
        items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
      }, PROD_TEST_PORT);
      assert(prodOrder.statusCode === 201, 'Production order placed successfully');

      // Attempt to create payment order without Razorpay credentials in production mode
      const prodPayOrder = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, {
        orderId: prodOrder.data.id
      }, PROD_TEST_PORT);

      assert(prodPayOrder.statusCode >= 500, 'Production mode with missing credentials fails closed (HTTP >= 500)');
      assert(prodPayOrder.data.code === 'PROVIDER_ORDER_CREATION_FAILED' || prodPayOrder.data.error, 'Returns clear provider configuration error');
      assert(!prodPayOrder.data.razorpayOrderId, 'Never returns synthetic order ID in production mode');

      // Verify order does NOT have a synthetic razorpayOrderId
      const prodState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${prodOrder.data.id}`, {}, null, PROD_TEST_PORT);
      const prodOrdDoc = (prodState.data.orders || []).find(o => o.id === prodOrder.data.id);
      assert(!prodOrdDoc.razorpayOrderId, 'Production order document does not bind fake razorpayOrderId on failure');
    } finally {
      prodProc.kill('SIGTERM');
      prodCleanup();
    }

    // ----------------------------------------------------
    // SECTION 3: WEBHOOK CRYPTOGRAPHIC SIGNATURE VERIFICATION
    // ----------------------------------------------------
    console.log('\n--- 3. WEBHOOK HMAC-SHA256 SIGNATURE VERIFICATION ---');
    const paymentId1 = `pay_test_${Date.now()}_1`;
    const eventId1 = `evt_test_${Date.now()}_1`;

    const webhookPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test_tiptap',
      event: 'order.paid',
      contains: ['payment', 'order'],
      payload: {
        payment: {
          entity: {
            id: paymentId1,
            order_id: rzpOrderId,
            amount: expectedPaise,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
            vpa: 'customer@okhdfcbank'
          }
        },
        order: {
          entity: {
            id: rzpOrderId,
            amount: expectedPaise,
            amount_paid: expectedPaise,
            currency: 'INR',
            status: 'paid'
          }
        }
      },
      created_at: Math.floor(Date.now() / 1000)
    });

    // 3a. Missing signature rejected
    const noSigRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {}, webhookPayload);
    assert(noSigRes.statusCode === 401, 'Unsigned webhook request strictly rejected with HTTP 401 Unauthorized');

    // 3b. Forged signature rejected
    const forgedSigRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': 'forged_fake_signature_hex_0000000000000000000000000000000000000000000000000000000000000000',
      'x-razorpay-event-id': eventId1
    }, webhookPayload);
    assert(forgedSigRes.statusCode === 401, 'Forged HMAC signature strictly rejected with HTTP 401 Unauthorized');

    // 3c. Tampered body rejected
    const validSig = computeWebhookSignature(webhookPayload);
    const tamperedPayload = webhookPayload.replace(String(expectedPaise), '100');
    const tamperedRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': validSig,
      'x-razorpay-event-id': eventId1
    }, tamperedPayload);
    assert(tamperedRes.statusCode === 401, 'Tampered request body alters HMAC and is rejected with HTTP 401 Unauthorized');

    // 3d. Authentic signature accepted & settles payment
    const validWebhookRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': validSig,
      'x-razorpay-event-id': eventId1
    }, webhookPayload);
    assert(validWebhookRes.statusCode === 200, 'Authentic signed webhook accepted with HTTP 200 OK');
    assert(validWebhookRes.data.settled === true, 'Webhook handler reports settled: true');

    // Confirm local order marked paid in database
    const postPayState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderId}`);
    const settledOrder = (postPayState.data.orders || []).find(o => o.id === orderId) ||
                         (postPayState.data.completedOrders || []).find(o => o.id === orderId);
    assert(settledOrder && settledOrder.isPaid === true, 'Order document updated to isPaid: true');
    assert(settledOrder && settledOrder.paymentStatus === 'paid', 'Order document paymentStatus updated to "paid"');
    assert(settledOrder && settledOrder.txnId === paymentId1, 'Order document records provider paymentId as txnId');

    // ----------------------------------------------------
    // SECTION 4: REPLAY & EVENT DEDUPLICATION
    // ----------------------------------------------------
    console.log('\n--- 4. REPLAY & DEDUPLICATION PROTECTION ---');
    // Replay identical webhook
    const replayRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': validSig,
      'x-razorpay-event-id': eventId1
    }, webhookPayload);
    assert(replayRes.statusCode === 200, 'Replayed webhook acknowledged safely with HTTP 200 OK');
    assert(replayRes.data.alreadyProcessed === true, 'Replayed event ID detected via unique constraint (alreadyProcessed: true)');

    // New event ID but same payment ID
    const eventId2 = `evt_test_${Date.now()}_2`;
    const newPayloadSamePayment = webhookPayload;
    const newSig = computeWebhookSignature(newPayloadSamePayment);
    const duplicatePaymentRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': newSig,
      'x-razorpay-event-id': eventId2
    }, newPayloadSamePayment);
    assert(duplicatePaymentRes.statusCode === 200, 'Duplicate payment ID acknowledged safely with HTTP 200 OK');
    assert(duplicatePaymentRes.data.alreadyProcessed === true, 'Duplicate payment ID blocked from double-settlement');

    // ----------------------------------------------------
    // SECTION 5: AMOUNT & CURRENCY VALIDATION
    // ----------------------------------------------------
    console.log('\n--- 5. AMOUNT & CURRENCY INTEGRITY VALIDATION ---');
    const order3Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 3,
      tableName: 'Table 3',
      customerPhone: '9876543212',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order3Id = order3Res.data.id;
    const payOrder3 = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order3Id });
    const rzpOrder3Id = payOrder3.data.razorpayOrderId;

    // Check initial customer spend before Section 5 webhook negative tests
    const custStateBeforeNeg5 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custBeforeNeg5 = (custStateBeforeNeg5.data.customers || []).find(c => c.phone === '9876543212');
    const spentBeforeNeg5 = custBeforeNeg5 ? custBeforeNeg5.totalSpent || 0 : 0;

    // 5a. Underpayment rejected
    const underpayPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_under_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 100, // 1 Rupee instead of 294
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const underpaySig = computeWebhookSignature(underpayPayload);
    const underpayRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': underpaySig,
      'x-razorpay-event-id': `evt_under_${Date.now()}`
    }, underpayPayload);
    assert(underpayRes.statusCode === 400, 'Underpayment webhook rejected with HTTP 400 Bad Request');

    // 5b. Non-INR currency rejected
    const nonInrPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_curr_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: 'USD',
            status: 'captured',
            method: 'card'
          }
        }
      }
    });
    const nonInrSig = computeWebhookSignature(nonInrPayload);
    const nonInrRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': nonInrSig,
      'x-razorpay-event-id': `evt_curr_${Date.now()}`
    }, nonInrPayload);
    assert(nonInrRes.statusCode === 400, 'Non-INR currency rejected with HTTP 400 Bad Request');

    // 5c. Finding 2: Missing currency rejected (never assume INR)
    const whMissingCurrPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_nocurr_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whMissingCurrSig = computeWebhookSignature(whMissingCurrPayload);
    const whMissingCurrRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whMissingCurrSig,
      'x-razorpay-event-id': `evt_nocurr_${Date.now()}`
    }, whMissingCurrPayload);
    assert(whMissingCurrRes.statusCode === 400, 'Webhook with missing currency rejected with HTTP 400 (never assumes INR)');

    // 5d. Finding 2: Null currency rejected
    const whNullCurrPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_nullcurr_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: null,
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whNullCurrSig = computeWebhookSignature(whNullCurrPayload);
    const whNullCurrRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whNullCurrSig,
      'x-razorpay-event-id': `evt_nullcurr_${Date.now()}`
    }, whNullCurrPayload);
    assert(whNullCurrRes.statusCode === 400, 'Webhook with null currency rejected with HTTP 400');

    // 5e. Finding 2: Empty string currency rejected
    const whEmptyCurrPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_emptycurr_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: '',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whEmptyCurrSig = computeWebhookSignature(whEmptyCurrPayload);
    const whEmptyCurrRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whEmptyCurrSig,
      'x-razorpay-event-id': `evt_emptycurr_${Date.now()}`
    }, whEmptyCurrPayload);
    assert(whEmptyCurrRes.statusCode === 400, 'Webhook with empty string currency rejected with HTTP 400');

    // 5f. Finding 3: Missing payment status in payment.captured rejected
    const whNoStatusPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_nostatus_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: 'INR',
            method: 'upi'
          }
        }
      }
    });
    const whNoStatusSig = computeWebhookSignature(whNoStatusPayload);
    const whNoStatusRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whNoStatusSig,
      'x-razorpay-event-id': `evt_nostatus_${Date.now()}`
    }, whNoStatusPayload);
    assert(whNoStatusRes.statusCode === 400, 'Webhook with missing payment status rejected with HTTP 400');

    // 5g. Finding 3: Non-captured status (authorized) in payment.captured rejected
    const whAuthStatusPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_authstatus_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: 'INR',
            status: 'authorized',
            method: 'upi'
          }
        }
      }
    });
    const whAuthStatusSig = computeWebhookSignature(whAuthStatusPayload);
    const whAuthStatusRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whAuthStatusSig,
      'x-razorpay-event-id': `evt_authstatus_${Date.now()}`
    }, whAuthStatusPayload);
    assert(whAuthStatusRes.statusCode === 400, 'Webhook payment with "authorized" status rejected with HTTP 400 (captured strictly required)');

    // 5h. Finding 3: Non-captured status in order.paid event rejected
    const whOrderPaidAuthPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: {
          entity: {
            id: rzpOrder3Id,
            amount: 29400,
            amount_paid: 29400,
            currency: 'INR',
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: `pay_ordpaid_auth_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: 'INR',
            status: 'authorized',
            method: 'upi'
          }
        }
      }
    });
    const whOrderPaidAuthSig = computeWebhookSignature(whOrderPaidAuthPayload);
    const whOrderPaidAuthRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whOrderPaidAuthSig,
      'x-razorpay-event-id': `evt_ordpaid_auth_${Date.now()}`
    }, whOrderPaidAuthPayload);
    assert(whOrderPaidAuthRes.statusCode === 400, 'order.paid webhook with "authorized" payment status rejected with HTTP 400');

    // 5i. Finding 3: Missing order_id in payment entity rejected
    const whNoOrdIdPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_noord_${Date.now()}`,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whNoOrdIdSig = computeWebhookSignature(whNoOrdIdPayload);
    const whNoOrdIdRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whNoOrdIdSig,
      'x-razorpay-event-id': `evt_noord_${Date.now()}`
    }, whNoOrdIdPayload);
    assert(whNoOrdIdRes.statusCode === 400, 'Webhook payment entity missing order_id rejected with HTTP 400');

    // 5j. Finding 2: Webhook order.paid missing paymentEntity.amount rejected even when orderEntity.amount_paid is correct
    const missingPayAmtWithOrderAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: {
          entity: {
            id: rzpOrder3Id,
            amount: 29400,
            amount_paid: 29400,
            currency: 'INR',
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: `pay_noamt_${Date.now()}`,
            order_id: rzpOrder3Id,
            // paymentEntity.amount is completely missing/undefined!
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const missingPayAmtSig = computeWebhookSignature(missingPayAmtWithOrderAmtPayload);
    const missingPayAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': missingPayAmtSig,
      'x-razorpay-event-id': `evt_noamt_${Date.now()}`
    }, missingPayAmtWithOrderAmtPayload);
    assert(missingPayAmtRes.statusCode === 400, 'order.paid webhook missing paymentEntity.amount rejected with HTTP 400 even when orderEntity.amount_paid is correct');
    assert(missingPayAmtRes.data.error && missingPayAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms paymentEntity.amount cannot be substituted by orderEntity.amount_paid');

    // 5k. Strict Type Validation: Boolean true rejected
    const boolAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_bool_${Date.now()}`, order_id: rzpOrder3Id, amount: true, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const boolAmtSig = computeWebhookSignature(boolAmtPayload);
    const boolAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': boolAmtSig,
      'x-razorpay-event-id': `evt_bool_${Date.now()}`
    }, boolAmtPayload);
    assert(boolAmtRes.statusCode === 400, 'order.paid webhook with boolean true amount rejected with HTTP 400');
    assert(boolAmtRes.data.error && boolAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms boolean amount rejected');

    // 5l. Strict Type Validation: Numeric string rejected
    const strAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_numstr_${Date.now()}`, order_id: rzpOrder3Id, amount: '29400', currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const strAmtSig = computeWebhookSignature(strAmtPayload);
    const strAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': strAmtSig,
      'x-razorpay-event-id': `evt_numstr_${Date.now()}`
    }, strAmtPayload);
    assert(strAmtRes.statusCode === 400, 'order.paid webhook with numeric string amount rejected with HTTP 400');
    assert(strAmtRes.data.error && strAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms numeric string amount rejected');

    // 5m. Strict Type Validation: Fractional amount rejected
    const fracAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_frac_${Date.now()}`, order_id: rzpOrder3Id, amount: 29400.5, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const fracAmtSig = computeWebhookSignature(fracAmtPayload);
    const fracAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': fracAmtSig,
      'x-razorpay-event-id': `evt_frac_${Date.now()}`
    }, fracAmtPayload);
    assert(fracAmtRes.statusCode === 400, 'order.paid webhook with fractional amount rejected with HTTP 400');
    assert(fracAmtRes.data.error && fracAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms fractional amount rejected');

    // 5n. Strict Type Validation: Unsafe integer rejected
    const unsafeAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_unsafe_${Date.now()}`, order_id: rzpOrder3Id, amount: 9007199254740992, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const unsafeAmtSig = computeWebhookSignature(unsafeAmtPayload);
    const unsafeAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': unsafeAmtSig,
      'x-razorpay-event-id': `evt_unsafe_${Date.now()}`
    }, unsafeAmtPayload);
    assert(unsafeAmtRes.statusCode === 400, 'order.paid webhook with unsafe integer amount rejected with HTTP 400');
    assert(unsafeAmtRes.data.error && unsafeAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms unsafe integer amount rejected');

    // 5o. Strict Type Validation: Zero amount rejected
    const zeroAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_zero_${Date.now()}`, order_id: rzpOrder3Id, amount: 0, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const zeroAmtSig = computeWebhookSignature(zeroAmtPayload);
    const zeroAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': zeroAmtSig,
      'x-razorpay-event-id': `evt_zero_${Date.now()}`
    }, zeroAmtPayload);
    assert(zeroAmtRes.statusCode === 400, 'order.paid webhook with zero amount rejected with HTTP 400');
    assert(zeroAmtRes.data.error && zeroAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms zero amount rejected');

    // 5p. Strict Type Validation: Negative amount rejected
    const negAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_neg_${Date.now()}`, order_id: rzpOrder3Id, amount: -29400, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const negAmtSig = computeWebhookSignature(negAmtPayload);
    const negAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': negAmtSig,
      'x-razorpay-event-id': `evt_neg_${Date.now()}`
    }, negAmtPayload);
    assert(negAmtRes.statusCode === 400, 'order.paid webhook with negative amount rejected with HTTP 400');
    assert(negAmtRes.data.error && negAmtRes.data.error.includes('paymentEntity.amount is mandatory'), 'Error confirms negative amount rejected');

    // 5q. orderEntity.amount_paid explicitly null rejected
    const nullOrdAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: null, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_nullordamt_${Date.now()}`, order_id: rzpOrder3Id, amount: 29400, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const nullOrdAmtSig = computeWebhookSignature(nullOrdAmtPayload);
    const nullOrdAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': nullOrdAmtSig,
      'x-razorpay-event-id': `evt_nullordamt_${Date.now()}`
    }, nullOrdAmtPayload);
    assert(nullOrdAmtRes.statusCode === 400, 'order.paid webhook with null orderEntity.amount_paid rejected with HTTP 400');
    assert(nullOrdAmtRes.data.error && nullOrdAmtRes.data.error.includes('orderEntity.amount_paid'), 'Error confirms null orderEntity.amount_paid rejected');

    // 5r. orderEntity.amount_paid numeric string rejected
    const strOrdAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: '29400', currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_strordamt_${Date.now()}`, order_id: rzpOrder3Id, amount: 29400, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const strOrdAmtSig = computeWebhookSignature(strOrdAmtPayload);
    const strOrdAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': strOrdAmtSig,
      'x-razorpay-event-id': `evt_strordamt_${Date.now()}`
    }, strOrdAmtPayload);
    assert(strOrdAmtRes.statusCode === 400, 'order.paid webhook with numeric string orderEntity.amount_paid rejected with HTTP 400');
    assert(strOrdAmtRes.data.error && strOrdAmtRes.data.error.includes('orderEntity.amount_paid'), 'Error confirms string orderEntity.amount_paid rejected');

    // 5s. orderEntity.amount_paid fractional value rejected
    const fracOrdAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 29400.5, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_fracordamt_${Date.now()}`, order_id: rzpOrder3Id, amount: 29400, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const fracOrdAmtSig = computeWebhookSignature(fracOrdAmtPayload);
    const fracOrdAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': fracOrdAmtSig,
      'x-razorpay-event-id': `evt_fracordamt_${Date.now()}`
    }, fracOrdAmtPayload);
    assert(fracOrdAmtRes.statusCode === 400, 'order.paid webhook with fractional orderEntity.amount_paid rejected with HTTP 400');
    assert(fracOrdAmtRes.data.error && fracOrdAmtRes.data.error.includes('orderEntity.amount_paid'), 'Error confirms fractional orderEntity.amount_paid rejected');

    // 5t. orderEntity.amount_paid mismatched value rejected
    const mismatchOrdAmtPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder3Id, amount: 29400, amount_paid: 20000, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: `pay_mismatchordamt_${Date.now()}`, order_id: rzpOrder3Id, amount: 29400, currency: 'INR', status: 'captured', method: 'upi' } }
      }
    });
    const mismatchOrdAmtSig = computeWebhookSignature(mismatchOrdAmtPayload);
    const mismatchOrdAmtRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': mismatchOrdAmtSig,
      'x-razorpay-event-id': `evt_mismatchordamt_${Date.now()}`
    }, mismatchOrdAmtPayload);
    assert(mismatchOrdAmtRes.statusCode === 400, 'order.paid webhook with mismatched orderEntity.amount_paid rejected with HTTP 400');
    assert(mismatchOrdAmtRes.data.error && mismatchOrdAmtRes.data.error.includes('orderEntity.amount_paid'), 'Error confirms mismatched orderEntity.amount_paid rejected');

    // PROOF: Verify order3 remained unpaid and zero customer spend was incremented after all invalid amount attempts
    const checkOrd3State = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${order3Id}`);
    const sec5OrdDoc = (checkOrd3State.data.orders || []).find(o => o.id === order3Id);
    assert(sec5OrdDoc && sec5OrdDoc.isPaid === false, 'Section 5 test order remains unpaid (isPaid: false) after rejected webhooks');

    const custStateAfterNeg5 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterNeg5 = (custStateAfterNeg5.data.customers || []).find(c => c.phone === '9876543212');
    const spentAfterNeg5 = custAfterNeg5 ? custAfterNeg5.totalSpent || 0 : 0;
    assert(spentAfterNeg5 === spentBeforeNeg5, 'Zero customer spend incremented during all Section 5 webhook negative tests');

    // ----------------------------------------------------
    // SECTION 6: FAILED PAYMENT ACKNOWLEDGEMENT
    // ----------------------------------------------------
    console.log('\n--- 6. FAILED PAYMENT ACKNOWLEDGEMENT ---');
    const failedPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: `pay_fail_${Date.now()}`,
            order_id: rzpOrder3Id,
            amount: 29400,
            currency: 'INR',
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'User cancelled payment on UPI app'
          }
        }
      }
    });
    const failedSig = computeWebhookSignature(failedPayload);
    const failedRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': failedSig,
      'x-razorpay-event-id': `evt_fail_${Date.now()}`
    }, failedPayload);
    assert(failedRes.statusCode === 200, 'payment.failed webhook acknowledged safely with HTTP 200');

    const checkOrder3 = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${order3Id}`);
    const ord3Doc = (checkOrder3.data.orders || []).find(o => o.id === order3Id);
    assert(ord3Doc && ord3Doc.isPaid === false, 'Failed payment event does NOT mark order paid (isPaid: false)');

    // ----------------------------------------------------
    // SECTION 7: MANDATORY PROVIDER FIELD VALIDATION & NEGATIVE TESTS
    // ----------------------------------------------------
    console.log('\n--- 7. MANDATORY PROVIDER FIELD VALIDATION & COMPREHENSIVE NEGATIVE TESTS ---');

    // Create a dedicated order to test all provider field negative scenarios
    const orderNegRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 7,
      tableName: 'Table 7',
      customerPhone: '9876543210',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // 294
    });
    const orderNegId = orderNegRes.data.id;
    const payOrderNeg = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderNegId });
    const rzpOrderNegId = payOrderNeg.data.razorpayOrderId;

    // Check initial customer spend before negative tests
    const custStateBeforeNeg = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custBeforeNeg = (custStateBeforeNeg.data.customers || []).find(c => c.phone === '9876543210');
    const spentBeforeNeg = custBeforeNeg ? custBeforeNeg.totalSpent || 0 : 0;

    // 7a. Unbound Order Rejection: Client-supplied order ID without server binding rejected
    const orderUnboundRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 8,
      tableName: 'Table 8',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const unboundOrderId = orderUnboundRes.data.id;
    const fakeClientOrderId = 'order_fake_client_unbound_999';
    const fakeClientPayId = `pay_fake_${Date.now()}`;
    const unboundRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: unboundOrderId,
      razorpay_order_id: fakeClientOrderId,
      razorpay_payment_id: fakeClientPayId,
      razorpay_signature: computeCheckoutSignature(fakeClientOrderId, fakeClientPayId)
    });
    assert(unboundRes.statusCode === 400, 'Unbound order rejected with HTTP 400 (client-supplied order ID not accepted)');

    // 7b. Forged client checkout signature rejected
    const paymentId3 = `pay_checkout_${Date.now()}`;
    const forgedCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: 'fake_forged_client_signature_hex'
    });
    assert(forgedCheckout.statusCode === 400, 'Forged client checkout signature rejected with HTTP 400 Bad Request');

    // 7c. Mismatched razorpay_order_id rejected
    const validCheckoutSig = computeCheckoutSignature(rzpOrderNegId, paymentId3);
    const mismatchedCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: 'order_DIFFERENT_MISMATCHED',
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(mismatchedCheckout.statusCode === 400, 'Mismatched razorpay_order_id rejected with HTTP 400 Bad Request');

    // 7d. Malformed provider payment response rejected
    const malformedPayId = `pay_test_malformed_${Date.now()}`;
    const malformedSig = computeCheckoutSignature(rzpOrderNegId, malformedPayId);
    const malformedRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: malformedPayId,
      razorpay_signature: malformedSig
    });
    assert(malformedRes.statusCode === 400, 'Malformed provider payment response rejected with HTTP 400');

    // 7e. Missing payment ID rejected
    const missingIdPayId = `pay_test_missing_id_${Date.now()}`;
    const missingIdSig = computeCheckoutSignature(rzpOrderNegId, missingIdPayId);
    const missingIdRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: missingIdPayId,
      razorpay_signature: missingIdSig
    });
    assert(missingIdRes.statusCode === 400, 'Provider response missing payment ID rejected with HTTP 400');

    // 7f. Wrong payment ID rejected
    const wrongIdPayId = `pay_test_wrong_id_${Date.now()}`;
    const wrongIdSig = computeCheckoutSignature(rzpOrderNegId, wrongIdPayId);
    const wrongIdRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: wrongIdPayId,
      razorpay_signature: wrongIdSig
    });
    assert(wrongIdRes.statusCode === 400, 'Provider response wrong payment ID rejected with HTTP 400');

    // 7g. Missing order_id rejected
    const missingOrdPayId = `pay_test_missing_order_id_${Date.now()}`;
    const missingOrdSig = computeCheckoutSignature(rzpOrderNegId, missingOrdPayId);
    const missingOrdRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: missingOrdPayId,
      razorpay_signature: missingOrdSig
    });
    assert(missingOrdRes.statusCode === 400, 'Provider response missing order_id rejected with HTTP 400');

    // 7h. Wrong order_id rejected
    const wrongOrdPayId = `pay_test_wrong_order_id_${Date.now()}`;
    const wrongOrdSig = computeCheckoutSignature(rzpOrderNegId, wrongOrdPayId);
    const wrongOrdRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: wrongOrdPayId,
      razorpay_signature: wrongOrdSig
    });
    assert(wrongOrdRes.statusCode === 400, 'Provider response wrong order_id rejected with HTTP 400');

    // 7i. Missing amount rejected
    const missingAmtPayId = `pay_test_missing_amount_${Date.now()}`;
    const missingAmtSig = computeCheckoutSignature(rzpOrderNegId, missingAmtPayId);
    const missingAmtRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: missingAmtPayId,
      razorpay_signature: missingAmtSig
    });
    assert(missingAmtRes.statusCode === 400, 'Provider response missing amount rejected with HTTP 400');

    // 7j. Incorrect amount rejected
    const wrongAmtPayId = `pay_test_wrong_amount_${Date.now()}`;
    const wrongAmtSig = computeCheckoutSignature(rzpOrderNegId, wrongAmtPayId);
    const wrongAmtRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: wrongAmtPayId,
      razorpay_signature: wrongAmtSig
    });
    assert(wrongAmtRes.statusCode === 400, 'Provider response incorrect amount rejected with HTTP 400');

    // 7k. Missing currency rejected
    const missingCurrPayId = `pay_test_missing_currency_${Date.now()}`;
    const missingCurrSig = computeCheckoutSignature(rzpOrderNegId, missingCurrPayId);
    const missingCurrRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: missingCurrPayId,
      razorpay_signature: missingCurrSig
    });
    assert(missingCurrRes.statusCode === 400, 'Provider response missing currency rejected with HTTP 400');

    // 7l. Incorrect currency rejected
    const wrongCurrPayId = `pay_test_wrong_currency_${Date.now()}`;
    const wrongCurrSig = computeCheckoutSignature(rzpOrderNegId, wrongCurrPayId);
    const wrongCurrRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: wrongCurrPayId,
      razorpay_signature: wrongCurrSig
    });
    assert(wrongCurrRes.statusCode === 400, 'Provider response incorrect currency rejected with HTTP 400');

    // 7m. Missing status rejected
    const missingStatusPayId = `pay_test_missing_status_${Date.now()}`;
    const missingStatusSig = computeCheckoutSignature(rzpOrderNegId, missingStatusPayId);
    const missingStatusRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: missingStatusPayId,
      razorpay_signature: missingStatusSig
    });
    assert(missingStatusRes.statusCode === 400, 'Provider response missing status rejected with HTTP 400');

    // 7n. Authorized-only payment status rejected
    const authOnlyPaymentId = `pay_auth_only_${Date.now()}`;
    const authOnlySig = computeCheckoutSignature(rzpOrderNegId, authOnlyPaymentId);
    const authOnlyRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: authOnlyPaymentId,
      razorpay_signature: authOnlySig
    });
    assert(authOnlyRes.statusCode === 400, 'Authorized-only payment rejected with HTTP 400 Bad Request');
    assert(authOnlyRes.data.status === 'authorized', 'Rejection reports provider status is authorized');

    // 7o. Failed status payment rejected
    const failedStatusPaymentId = `pay_failed_status_${Date.now()}`;
    const failedStatusSig = computeCheckoutSignature(rzpOrderNegId, failedStatusPaymentId);
    const failedStatusRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: failedStatusPaymentId,
      razorpay_signature: failedStatusSig
    });
    assert(failedStatusRes.statusCode === 400, 'Failed provider status rejected with HTTP 400 Bad Request');

    // 7p. Provider timeout returns safe non-settlement pending status
    const timeoutPaymentId = `pay_provider_timeout_${Date.now()}`;
    const timeoutSig = computeCheckoutSignature(rzpOrderNegId, timeoutPaymentId);
    const timeoutRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: timeoutPaymentId,
      razorpay_signature: timeoutSig
    });
    assert(timeoutRes.statusCode === 502 || timeoutRes.statusCode === 504 || timeoutRes.statusCode === 400, 'Provider timeout returns safe non-settlement status');
    assert(timeoutRes.data.status === 'pending_verification', 'Returns pending_verification status on timeout');

    // 7q. Provider API error returns safe non-settlement pending status
    const errorPaymentId = `pay_provider_error_${Date.now()}`;
    const errorSig = computeCheckoutSignature(rzpOrderNegId, errorPaymentId);
    const errorRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: errorPaymentId,
      razorpay_signature: errorSig
    });
    assert(errorRes.statusCode === 502 || errorRes.statusCode === 504 || errorRes.statusCode === 400, 'Provider API error returns safe non-settlement status');
    assert(errorRes.data.status === 'pending_verification', 'Returns pending_verification status on provider API error');

    // PROOF: Verify orderNeg remained unpaid and zero customer spend was incremented
    const checkNegState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderNegId}`);
    const negOrdDoc = (checkNegState.data.orders || []).find(o => o.id === orderNegId);
    assert(negOrdDoc && negOrdDoc.isPaid === false, 'Negative test order remains unpaid (isPaid: false)');

    const custStateAfterNeg = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterNeg = (custStateAfterNeg.data.customers || []).find(c => c.phone === '9876543210');
    const spentAfterNeg = custAfterNeg ? custAfterNeg.totalSpent || 0 : 0;
    assert(spentAfterNeg === spentBeforeNeg, 'Zero customer spend incremented during all negative tests');

    // 7r. Authentic signature with captured status settles order
    const validCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(validCheckout.statusCode === 200, 'Valid cryptographically signed Checkout callback accepted (HTTP 200)');
    assert(validCheckout.data.verified === true, 'Checkout verification response confirms verified: true');
    assert(validCheckout.data.order.isPaid === true, 'Order marked isPaid: true via verified signature & captured status');

    // 7s. Idempotent re-submission
    const repeatCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(repeatCheckout.statusCode === 200, 'Repeated client signature submission acknowledged with HTTP 200');

    // ----------------------------------------------------
    // 7t. FINDING 1: COMPLETED ORDER VERIFICATION PROTECTION & IDEMPOTENCY
    // ----------------------------------------------------
    console.log('\n--- 7t. COMPLETED ORDER VERIFICATION PROTECTION & IDEMPOTENT RETRY ---');
    // Transition orderNeg to completedOrders by serving food (it is already paid)
    const serveRes = await makeRequest('PATCH', `/api/orders/${orderNegId}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });
    assert(serveRes.statusCode === 200 || serveRes.statusCode === 204, 'Order transitioned to served status');

    // Verify order is now in completedOrders
    const compState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderNegId}`);
    const completedDoc = (compState.data.completedOrders || []).find(o => o.id === orderNegId);
    assert(Boolean(completedDoc), 'Order successfully archived into completedOrders');

    // 7t-1: Forged cryptographic signature on completed order strictly rejected with HTTP 400
    const forgedCompRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: 'fake_forged_signature_on_completed_order_hex_000000000000'
    });
    assert(forgedCompRes.statusCode === 400, 'Forged signature on completed order strictly rejected with HTTP 400 (never returns verified:true)');
    assert(!forgedCompRes.data.verified, 'Forged signature response does NOT report verified: true');

    // 7t-2: Conflicting payment ID on completed order strictly rejected with HTTP 400
    const diffPayIdComp = `pay_diff_comp_${Date.now()}`;
    const diffPayCompSig = computeCheckoutSignature(rzpOrderNegId, diffPayIdComp);
    const diffPayCompRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: diffPayIdComp,
      razorpay_signature: diffPayCompSig
    });
    assert(diffPayCompRes.statusCode === 400, 'Conflicting payment ID on completed order rejected with HTTP 400');
    assert(diffPayCompRes.data.error && diffPayCompRes.data.error.includes('already settled with payment ID'), 'Error confirms payment ID mismatch on completed order');

    // 7t-3: Legitimate idempotent retry on completed order with matching payment ID returns HTTP 200
    const legitCompRetryRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(legitCompRetryRes.statusCode === 200, 'Legitimate retry on completed order returns HTTP 200 OK');
    assert(legitCompRetryRes.data.verified === true, 'Legitimate retry confirms verified: true');
    assert(legitCompRetryRes.data.alreadySettled === true, 'Legitimate retry confirms alreadySettled: true');

    // 7t-4: Verify sensitive fields are NOT leaked in completed order response
    assert(!legitCompRetryRes.data.order.customerPhone, 'Sanitized completed order does not leak customer phone');
    assert(!legitCompRetryRes.data.order.serviceRequests, 'Sanitized completed order does not leak service requests');

    // 7t-5: Missing txnId on completed order rejected with HTTP 400
    const missingTxnRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig,
      simulateIncompleteRecord: 'missing_txnId'
    });
    assert(missingTxnRes.statusCode === 400, 'Completed order with missing txnId rejected with HTTP 400');
    assert(missingTxnRes.data.error && missingTxnRes.data.error.includes('Missing persisted txnId'), 'Error confirms missing txnId rejected');

    // 7t-6: Missing paymentDetails.paymentId on completed order rejected with HTTP 400
    const missingDetailsRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig,
      simulateIncompleteRecord: 'missing_paymentDetails'
    });
    assert(missingDetailsRes.statusCode === 400, 'Completed order with missing paymentDetails.paymentId rejected with HTTP 400');
    assert(missingDetailsRes.data.error && missingDetailsRes.data.error.includes('Missing persisted paymentDetails'), 'Error confirms missing paymentDetails rejected');

    // 7t-7: Missing processedPayments entry on completed order rejected with HTTP 400
    const missingProcessedRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderNegId,
      razorpay_order_id: rzpOrderNegId,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig,
      simulateIncompleteRecord: 'missing_processedPayments'
    });
    assert(missingProcessedRes.statusCode === 400, 'Completed order with missing processedPayments entry rejected with HTTP 400');
    assert(missingProcessedRes.data.error && missingProcessedRes.data.error.includes('No matching processedPayments entry found'), 'Error confirms missing processedPayments entry rejected');

    // ----------------------------------------------------
    // SECTION 8: CROSS-TENANT ORDER BINDING INTEGRITY & WEBHOOK TENANT ENFORCEMENT
    // ----------------------------------------------------
    console.log('\n--- 8. CROSS-TENANT PAYMENT ASSOCIATION & WEBHOOK ENFORCEMENT ---');
    const crossRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=sharma-dhaba', {}, {
      orderId: order3Id, // tiptap-bistro order
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: `pay_cross_${Date.now()}`,
      razorpay_signature: validCheckoutSig
    });
    assert(crossRes.statusCode === 404, 'Cross-tenant order verification rejected with HTTP 404 Not Found');

    // 8b. Cross-tenant webhook query mismatch rejection
    const crossTenantWebhookPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_cross_wh_${Date.now()}`,
            order_id: rzpOrder3Id, // belongs to tiptap-bistro
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const crossTenantSig = computeWebhookSignature(crossTenantWebhookPayload);
    const crossTenantWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=sharma-dhaba', {
      'x-razorpay-signature': crossTenantSig,
      'x-razorpay-event-id': `evt_cross_${Date.now()}`
    }, crossTenantWebhookPayload);
    assert(crossTenantWhRes.statusCode === 403, 'Cross-tenant webhook query mismatch strictly rejected with HTTP 403 Forbidden');

    // 8c. Webhook order.paid without provider payment entity rejected (never fabricate payment ID)
    const missingPayEntityPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: {
          entity: {
            id: rzpOrder3Id,
            amount: 29400,
            amount_paid: 29400,
            currency: 'INR',
            status: 'paid'
          }
        }
        // payment entity completely missing
      }
    });
    const missingEntitySig = computeWebhookSignature(missingPayEntityPayload);
    const missingEntityRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': missingEntitySig,
      'x-razorpay-event-id': `evt_missing_entity_${Date.now()}`
    }, missingPayEntityPayload);
    assert(missingEntityRes.statusCode === 400, 'Webhook order.paid with missing payment entity rejected with HTTP 400 (never fabricates synthetic payment ID)');

    // ----------------------------------------------------
    // SECTION 9: CONCURRENCY & RACE CONDITIONS
    // ----------------------------------------------------
    console.log('\n--- 9. CONCURRENCY & RACE CONDITIONS ---');
    const order5Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 5,
      tableName: 'Table 5',
      customerPhone: '9876543210',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const order5Id = order5Res.data.id;
    const payOrder5 = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order5Id });
    const rzpOrder5Id = payOrder5.data.razorpayOrderId;
    const paymentId5 = `pay_race_${Date.now()}`;

    // Get customer CRM before concurrent settlements (using staff pin to view CRM data)
    const custStateBefore = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const customerBefore = (custStateBefore.data.customers || []).find(c => c.phone === '9876543210');
    const spentBefore = customerBefore ? customerBefore.totalSpent || 0 : 0;

    // Race: Fire 4 simultaneous settlement attempts (2 webhooks and 2 checkout callbacks)
    const webhookPayload5 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId5,
            order_id: rzpOrder5Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const sig5 = computeWebhookSignature(webhookPayload5);
    const checkoutSig5 = computeCheckoutSignature(rzpOrder5Id, paymentId5);

    const raceResults = await Promise.all([
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', { 'x-razorpay-signature': sig5, 'x-razorpay-event-id': `evt_race_1_${Date.now()}` }, webhookPayload5),
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', { 'x-razorpay-signature': sig5, 'x-razorpay-event-id': `evt_race_2_${Date.now()}` }, webhookPayload5),
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, { orderId: order5Id, razorpay_order_id: rzpOrder5Id, razorpay_payment_id: paymentId5, razorpay_signature: checkoutSig5 }),
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, { orderId: order5Id, razorpay_order_id: rzpOrder5Id, razorpay_payment_id: paymentId5, razorpay_signature: checkoutSig5 })
    ]);

    // All requests should return 200 (either first settlement or idempotent acknowledgement)
    const all200 = raceResults.every(r => r.statusCode === 200);
    assert(all200, 'All concurrent settlement requests returned HTTP 200 without race condition crashes');

    // Confirm customer spend was incremented by exactly one order total (294), NOT 4 times
    const custStateAfter = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const customerAfter = (custStateAfter.data.customers || []).find(c => c.phone === '9876543210');
    const spentAfter = customerAfter ? customerAfter.totalSpent || 0 : 0;
    assert(spentAfter === spentBefore + 294, `Customer lifetime spend incremented exactly once (${spentBefore + 294}), got ${spentAfter}`);

    // 9b. Duplicate Payment Across Multiple Orders Violation Prevention
    console.log('\n--- 9b. DUPLICATE PAYMENT ACROSS DIFFERENT ORDERS PREVENTION ---');
    const orderARes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 9,
      tableName: 'Table 9',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderAId = orderARes.data.id;
    const payOrderA = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderAId });
    const rzpOrderAId = payOrderA.data.razorpayOrderId;

    const orderBRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 10,
      tableName: 'Table 10',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderBId = orderBRes.data.id;
    const payOrderB = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderBId });
    const rzpOrderBId = payOrderB.data.razorpayOrderId;

    const sharedPaymentId = `pay_cross_order_${Date.now()}`;
    const sigA = computeCheckoutSignature(rzpOrderAId, sharedPaymentId);
    const sigB = computeCheckoutSignature(rzpOrderBId, sharedPaymentId);

    // Settle Order A with sharedPaymentId
    const settleARes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderAId,
      razorpay_order_id: rzpOrderAId,
      razorpay_payment_id: sharedPaymentId,
      razorpay_signature: sigA
    });
    assert(settleARes.statusCode === 200, 'Order A settled successfully with payment ID');

    // Attempt to settle Order B with the SAME payment ID
    const settleBRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderBId,
      razorpay_order_id: rzpOrderBId,
      razorpay_payment_id: sharedPaymentId,
      razorpay_signature: sigB
    });
    assert(settleBRes.statusCode === 400, 'Attempt to settle Order B with already-consumed payment ID strictly rejected with HTTP 400');
    assert(settleBRes.data.error && settleBRes.data.error.includes('Cannot settle multiple orders'), 'Rejection error confirms payment ID already consumed');

    // Verify Order B remains unpaid
    const checkOrderBState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderBId}`);
    const ordBDoc = (checkOrderBState.data.orders || []).find(o => o.id === orderBId);
    assert(ordBDoc && ordBDoc.isPaid === false, 'Order B remains unpaid after duplicate payment rejection');

    // 9c. Attempt to settle already-paid Order A with a different payment ID
    const differentPaymentId = `pay_different_${Date.now()}`;
    const sigADiff = computeCheckoutSignature(rzpOrderAId, differentPaymentId);
    const settleADiffRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderAId,
      razorpay_order_id: rzpOrderAId,
      razorpay_payment_id: differentPaymentId,
      razorpay_signature: sigADiff
    });
    assert(settleADiffRes.statusCode === 400, 'Attempt to settle already-settled Order A with different payment ID rejected with HTTP 400');
    assert(settleADiffRes.data.error && settleADiffRes.data.error.includes('already settled with payment ID'), 'Rejection error confirms conflicting payment ID rejected');

    // ----------------------------------------------------
    // SECTION 9d: TARGETED REMEDIATION REGRESSION TESTS (A THROUGH E)
    // ----------------------------------------------------
    console.log('\n--- 9d. TARGETED REMEDIATION REGRESSION TESTS (A THROUGH E) ---');

    // TEST A: Cross-order duplicate payment race
    console.log('\n  [TEST A]: Cross-order duplicate payment race');
    const orderRaceARes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 31,
      tableName: 'Table 31',
      customerPhone: '9876543221',
      customerName: 'Racer A',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderRaceAId = orderRaceARes.data.id;
    const payOrderRaceARes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderRaceAId });
    const rzpOrderRaceAId = payOrderRaceARes.data.razorpayOrderId;

    const orderRaceBRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 32,
      tableName: 'Table 32',
      customerPhone: '9876543222',
      customerName: 'Racer B',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderRaceBId = orderRaceBRes.data.id;
    const payOrderRaceBRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderRaceBId });
    const rzpOrderRaceBId = payOrderRaceBRes.data.razorpayOrderId;

    const sharedRacePayId = `pay_race_shared_${Date.now()}`;
    const sigRaceA = computeCheckoutSignature(rzpOrderRaceAId, sharedRacePayId);
    const sigRaceB = computeCheckoutSignature(rzpOrderRaceBId, sharedRacePayId);

    // Concurrently fire settlement for both distinct orders using identical payment ID
    const [raceResA, raceResB] = await Promise.all([
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
        orderId: orderRaceAId,
        razorpay_order_id: rzpOrderRaceAId,
        razorpay_payment_id: sharedRacePayId,
        razorpay_signature: sigRaceA
      }),
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
        orderId: orderRaceBId,
        razorpay_order_id: rzpOrderRaceBId,
        razorpay_payment_id: sharedRacePayId,
        razorpay_signature: sigRaceB
      })
    ]);

    const winnerRes = raceResA.statusCode === 200 ? raceResA : raceResB;
    const loserRes = raceResA.statusCode === 200 ? raceResB : raceResA;
    const winningOrderId = raceResA.statusCode === 200 ? orderRaceAId : orderRaceBId;
    const losingOrderId = raceResA.statusCode === 200 ? orderRaceBId : orderRaceAId;
    const winningPhone = raceResA.statusCode === 200 ? '9876543221' : '9876543222';
    const losingPhone = raceResA.statusCode === 200 ? '9876543222' : '9876543221';

    assert(winnerRes.statusCode === 200 && winnerRes.data.verified === true, 'Test A: Exactly one order wins the race and settles successfully with HTTP 200');
    assert(loserRes.statusCode === 400 && loserRes.data.error && loserRes.data.error.includes('Cannot settle multiple orders with same payment'), 'Test A: Losing order is strictly rejected with HTTP 400 duplicate payment violation');
    assert(loserRes.data.verified !== true && loserRes.data.success !== true, 'Test A: Losing order receives no false success response');

    // Verify losing order remains unpaid
    const checkLosingOrderState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${losingOrderId}`);
    const losingOrdDoc = (checkLosingOrderState.data.orders || []).find(o => o.id === losingOrderId);
    assert(losingOrdDoc && losingOrdDoc.isPaid === false && losingOrdDoc.paymentStatus !== 'paid', 'Test A: Losing order remains unpaid (isPaid: false) in database');

    // Verify CRM lifetime spend incremented ONLY for the winning order
    const custRaceStateAfter = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custWinnerAfter = (custRaceStateAfter.data.customers || []).find(c => c.phone === winningPhone);
    const custLoserAfter = (custRaceStateAfter.data.customers || []).find(c => c.phone === losingPhone);
    assert((custWinnerAfter ? custWinnerAfter.totalSpent : 0) === 294, 'Test A: Customer spend incremented for legitimate winning settlement');
    assert((custLoserAfter ? custLoserAfter.totalSpent : 0) === 0, 'Test A: Zero customer spend incremented for rejected settlement');

    // Verify payment records in db point to exactly one order
    const currentDbSnapshotA = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(currentDbSnapshotA.processedPayments && currentDbSnapshotA.processedPayments[sharedRacePayId] && currentDbSnapshotA.processedPayments[sharedRacePayId].orderId === winningOrderId, 'Test A: Processed payment records point to exactly one order (the winning order)');

    // TEST B: Same-order duplicate delivery
    console.log('\n  [TEST B]: Same-order duplicate delivery');
    const orderDupRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 33,
      tableName: 'Table 33',
      customerPhone: '9876543223',
      customerName: 'Dup User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderDupId = orderDupRes.data.id;
    const payOrderDupRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderDupId });
    const rzpOrderDupId = payOrderDupRes.data.razorpayOrderId;
    const dupPaymentId = `pay_dup_deliv_${Date.now()}`;

    const dupWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: dupPaymentId,
            order_id: rzpOrderDupId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const dupWhSig = computeWebhookSignature(dupWhPayload);
    const dupCheckoutSig = computeCheckoutSignature(rzpOrderDupId, dupPaymentId);

    // Get customer CRM before
    const custDupStateBefore = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custDupBefore = (custDupStateBefore.data.customers || []).find(c => c.phone === '9876543223');
    const spentDupBefore = custDupBefore ? (custDupBefore.totalSpent || 0) : 0;

    // Fire 2 webhooks and 2 checkout callbacks concurrently for the same order
    const dupDeliveries = await Promise.all([
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', { 'x-razorpay-signature': dupWhSig, 'x-razorpay-event-id': `evt_dup_a_${Date.now()}` }, dupWhPayload),
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', { 'x-razorpay-signature': dupWhSig, 'x-razorpay-event-id': `evt_dup_b_${Date.now()}` }, dupWhPayload),
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, { orderId: orderDupId, razorpay_order_id: rzpOrderDupId, razorpay_payment_id: dupPaymentId, razorpay_signature: dupCheckoutSig }),
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, { orderId: orderDupId, razorpay_order_id: rzpOrderDupId, razorpay_payment_id: dupPaymentId, razorpay_signature: dupCheckoutSig })
    ]);

    const allDup200 = dupDeliveries.every(r => r.statusCode === 200);
    assert(allDup200, 'Test B: All concurrent webhook and checkout duplicate deliveries returned HTTP 200');

    // Verify idempotent response indicators
    const hasAlreadySettledOrProcessed = dupDeliveries.some(r => r.data && (r.data.alreadySettled === true || r.data.alreadyProcessed === true));
    assert(hasAlreadySettledOrProcessed, 'Test B: Retries returned documented idempotent acknowledgement (alreadySettled / alreadyProcessed)');

    // Verify customer spend incremented exactly once (294)
    const custDupStateAfter = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custDupAfter = (custDupStateAfter.data.customers || []).find(c => c.phone === '9876543223');
    const spentDupAfter = custDupAfter ? (custDupAfter.totalSpent || 0) : 0;
    assert(spentDupAfter === spentDupBefore + 294, `Test B: Customer spend incremented exactly once (+294), got ${spentDupAfter}`);

    // TEST C: Persistence failure simulation & state rollback
    console.log('\n  [TEST C]: Persistence failure simulation & state rollback');
    const orderFailRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 34,
      tableName: 'Table 34',
      customerPhone: '9876543224',
      customerName: 'Fail Persist User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderFailId = orderFailRes.data.id;
    const payOrderFailRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderFailId });
    const rzpOrderFailId = payOrderFailRes.data.razorpayOrderId;
    const failPaymentId = `pay_fail_persist_${Date.now()}`;
    const failSig = computeCheckoutSignature(rzpOrderFailId, failPaymentId);

    // Attempt settlement with fail_persist trigger in paymentId
    const settleFailRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderFailId,
      razorpay_order_id: rzpOrderFailId,
      razorpay_payment_id: failPaymentId,
      razorpay_signature: failSig
    });

    assert(settleFailRes.statusCode === 500, 'Test C: Persistence failure returns HTTP 500');
    assert(settleFailRes.data.error && (settleFailRes.data.error.includes('mutation failure') || settleFailRes.data.error.includes('mutation failed') || settleFailRes.data.error.includes('Database mutation failed')), 'Test C: Error explains database mutation failure');
    assert(settleFailRes.data.verified !== true && settleFailRes.data.success !== true, 'Test C: No false success response emitted');

    // Confirm order remains unpaid and state is not partially mutated
    const checkFailOrderState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderFailId}`);
    const failOrdDoc = (checkFailOrderState.data.orders || []).find(o => o.id === orderFailId);
    assert(failOrdDoc && failOrdDoc.isPaid === false && failOrdDoc.paymentStatus !== 'paid', 'Test C: In-memory order rolled back to unpaid (isPaid: false)');
    assert(!failOrdDoc.txnId, 'Test C: In-memory order txnId rolled back/cleared');

    // Confirm customer spend was not incremented
    const custFailState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custFail = (custFailState.data.customers || []).find(c => c.phone === '9876543224');
    assert((custFail ? custFail.totalSpent : 0) === 0, 'Test C: Customer lifetime spend not incremented on persistence failure');

    // TEST D: Shared settlement result-handling explicit coverage
    console.log('\n  [TEST D]: Shared settlement result-handling explicit coverage');
    // D1: Explicitly test success: false via webhook caller
    const orderFailWhRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 35,
      tableName: 'Table 35',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderFailWhId = orderFailWhRes.data.id;
    const payOrderFailWh = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderFailWhId });
    const rzpOrderFailWhId = payOrderFailWh.data.razorpayOrderId;
    const failWhPaymentId = `pay_fail_persist_wh_${Date.now()}`;
    const failWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: failWhPaymentId,
            order_id: rzpOrderFailWhId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const failWhSig = computeWebhookSignature(failWhPayload);
    const failWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': failWhSig,
      'x-razorpay-event-id': `evt_fail_wh_${Date.now()}`
    }, failWhPayload);
    assert(failWhRes.statusCode === 500, 'Test D1: Webhook caller handles settlement success: false with HTTP 500');
    assert(failWhRes.data.status === 'error' && failWhRes.data.settled === false, 'Test D1: Webhook response body confirms status: error and settled: false');

    // D2: Explicitly test duplicatePaymentViolation via webhook caller
    const dupViolationWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: sharedRacePayId, // Already consumed by winning order in Test A
            order_id: rzpOrderFailWhId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const dupViolationWhSig = computeWebhookSignature(dupViolationWhPayload);
    const dupViolationWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': dupViolationWhSig,
      'x-razorpay-event-id': `evt_dup_viol_${Date.now()}`
    }, dupViolationWhPayload);
    assert(dupViolationWhRes.statusCode === 400, 'Test D2: Webhook caller handles duplicatePaymentViolation with HTTP 400');
    assert(dupViolationWhRes.data.status === 'error' && dupViolationWhRes.data.settled === false, 'Test D2: Webhook response body confirms error and settled: false');
    assert(dupViolationWhRes.data.error && dupViolationWhRes.data.error.includes('Cannot settle multiple orders with same payment'), 'Test D2: Error explains duplicate payment violation');

    // D3: Explicitly test alreadySettled via webhook caller
    const alreadySettledWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: dupPaymentId, // Settled in Test B for orderDupId
            order_id: rzpOrderDupId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const alreadySettledWhSig = computeWebhookSignature(alreadySettledWhPayload);
    const alreadySettledWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': alreadySettledWhSig,
      'x-razorpay-event-id': `evt_already_settled_${Date.now()}`
    }, alreadySettledWhPayload);
    assert(alreadySettledWhRes.statusCode === 200, 'Test D3: Webhook caller handles alreadySettled with HTTP 200');
    assert(alreadySettledWhRes.data.status === 'ok' && alreadySettledWhRes.data.settled === true && alreadySettledWhRes.data.alreadySettled === true, 'Test D3: Webhook response confirms settled: true, alreadySettled: true');

    // D4: Explicitly test alreadyProcessed via webhook caller (replaying identical event ID)
    const replayEventId = `evt_already_proc_${Date.now()}`;
    const firstProcRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': alreadySettledWhSig,
      'x-razorpay-event-id': replayEventId
    }, alreadySettledWhPayload);
    assert(firstProcRes.statusCode === 200, 'Test D4: Initial webhook event processed successfully');

    const replayProcRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': alreadySettledWhSig,
      'x-razorpay-event-id': replayEventId
    }, alreadySettledWhPayload);
    assert(replayProcRes.statusCode === 200, 'Test D4: Webhook caller handles alreadyProcessed replay with HTTP 200');
    assert(replayProcRes.data.status === 'ok' && replayProcRes.data.settled === true && replayProcRes.data.alreadyProcessed === true, 'Test D4: Webhook response confirms settled: true, alreadyProcessed: true');

    // TEST E: Cross-tenant duplicate payment isolation
    console.log('\n  [TEST E]: Cross-tenant duplicate payment isolation');
    const orderTenantARes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 36,
      tableName: 'Table 36',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderTenantAId = orderTenantARes.data.id;
    const payTenantARes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderTenantAId });
    const rzpTenantAId = payTenantARes.data.razorpayOrderId;
    const crossTenantSharedPayId = `pay_cross_tenant_iso_${Date.now()}`;
    const sigTenantA = computeCheckoutSignature(rzpTenantAId, crossTenantSharedPayId);

    // Settle Order on tiptap-bistro
    const settleTenantARes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderTenantAId,
      razorpay_order_id: rzpTenantAId,
      razorpay_payment_id: crossTenantSharedPayId,
      razorpay_signature: sigTenantA
    });
    assert(settleTenantARes.statusCode === 200, 'Test E: Tenant A (tiptap-bistro) order settled successfully with shared payment ID');

    // Create an order on sharma-dhaba
    const orderTenantBRes = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {}, {
      tableId: 1,
      tableName: 'Table 1',
      customerPhone: '9876543225',
      customerName: 'Tenant B User',
      items: [{ id: 'sharma-dhaba_m1', qty: 1 }] // price 280
    });
    const orderTenantBId = orderTenantBRes.data.id;
    const payTenantBRes = await makeRequest('POST', '/api/create-payment-order?restaurant=sharma-dhaba', {}, { orderId: orderTenantBId });
    const rzpTenantBId = payTenantBRes.data.razorpayOrderId;
    const sigTenantB = computeCheckoutSignature(rzpTenantBId, crossTenantSharedPayId);

    // Attempt to settle sharma-dhaba order using the payment ID already consumed on tiptap-bistro
    const settleTenantBRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=sharma-dhaba', {}, {
      orderId: orderTenantBId,
      razorpay_order_id: rzpTenantBId,
      razorpay_payment_id: crossTenantSharedPayId,
      razorpay_signature: sigTenantB
    });
    assert(settleTenantBRes.statusCode === 400, 'Test E: Cross-tenant duplicate payment strictly rejected with HTTP 400');
    assert(settleTenantBRes.data.error && settleTenantBRes.data.error.includes('Cannot settle multiple orders with same payment'), 'Test E: Error confirms payment already consumed by another order');

    // Verify sharma-dhaba order remains unpaid
    const checkTenantBState = await makeRequest('GET', `/api/state?restaurant=sharma-dhaba&orderId=${orderTenantBId}`);
    const ordBDocTenant = (checkTenantBState.data.orders || []).find(o => o.id === orderTenantBId);
    assert(ordBDocTenant && ordBDocTenant.isPaid === false && ordBDocTenant.paymentStatus !== 'paid', 'Test E: Cross-tenant order remains unpaid (isPaid: false)');

    // Verify customer spend on sharma-dhaba was not incremented
    const custTenantBState = await makeRequest('GET', '/api/state?restaurant=sharma-dhaba', { 'x-master-pin': 'SuperAdminPin#Phase10' });
    const custTenantB = (custTenantBState.data.customers || []).find(c => c.phone === '9876543225');
    assert((custTenantB ? custTenantB.totalSpent : 0) === 0, 'Test E: Zero customer spend mutation on cross-tenant rejected settlement');

    // ----------------------------------------------------
    // SECTION 9e: COMPLETED-ORDER PAYMENT IDENTITY SECURITY TESTS (TESTS F THROUGH J)
    // ----------------------------------------------------
    console.log('\n--- 9e. COMPLETED-ORDER PAYMENT IDENTITY SECURITY TESTS (F THROUGH J) ---');

    // TEST F: Completed Order Claims Another Order's Payment ID
    console.log('\n  [TEST F]: Completed order claims another order payment ID');
    const orderF1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 41,
      tableName: 'Table 41',
      customerPhone: '9876543231',
      customerName: 'F1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderF1Id = orderF1Res.data.id;
    const payOrderF1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderF1Id });
    const rzpOrderF1Id = payOrderF1Res.data.razorpayOrderId;
    const paymentIdF1 = `pay_f1_legit_${Date.now()}`;
    const sigF1 = computeCheckoutSignature(rzpOrderF1Id, paymentIdF1);

    // Settle Order F1
    const settleF1Res = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderF1Id,
      razorpay_order_id: rzpOrderF1Id,
      razorpay_payment_id: paymentIdF1,
      razorpay_signature: sigF1
    });
    assert(settleF1Res.statusCode === 200, 'Test F: Order F1 settled successfully');

    // Complete Order F1 by transitioning kitchen status to served
    const completeF1Res = await makeRequest('PATCH', `/api/orders/${orderF1Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });
    assert(completeF1Res.statusCode === 200 || completeF1Res.statusCode === 204, 'Test F: Order F1 transitioned to served and archived into completedOrders');

    // Create Order F2
    const orderF2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 42,
      tableName: 'Table 42',
      customerPhone: '9876543232',
      customerName: 'F2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderF2Id = orderF2Res.data.id;
    const payOrderF2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderF2Id });
    const rzpOrderF2Id = payOrderF2Res.data.razorpayOrderId;
    const paymentIdF2 = `pay_f2_legit_${Date.now()}`;
    const sigF2 = computeCheckoutSignature(rzpOrderF2Id, paymentIdF2);

    // Settle Order F2
    const settleF2Res = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderF2Id,
      razorpay_order_id: rzpOrderF2Id,
      razorpay_payment_id: paymentIdF2,
      razorpay_signature: sigF2
    });
    assert(settleF2Res.statusCode === 200, 'Test F: Order F2 settled successfully');

    // Complete Order F2
    const completeF2Res = await makeRequest('PATCH', `/api/orders/${orderF2Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });
    assert(completeF2Res.statusCode === 200 || completeF2Res.statusCode === 204, 'Test F: Order F2 transitioned to served and archived into completedOrders');

    // Attempt to process paymentIdF1 (which belongs to Order F1) against completed Order F2 via webhook
    const hijackWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdF1,
            order_id: rzpOrderF2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const hijackWhSig = computeWebhookSignature(hijackWhPayload);
    const hijackWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': hijackWhSig,
      'x-razorpay-event-id': `evt_hijack_${Date.now()}`
    }, hijackWhPayload);

    assert(hijackWhRes.statusCode === 400, 'Test F: Attempt by completed Order F2 to claim payment ID belonging to Order F1 rejected with HTTP 400');
    assert(hijackWhRes.data.error && (hijackWhRes.data.error.includes('Cannot settle multiple orders with same payment') || hijackWhRes.data.error.includes('already settled with payment ID')), 'Test F: Error explains payment ID already consumed or mismatched');

    // Verify original payment record still belongs to Order F1
    const currentDbSnapshotF = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(currentDbSnapshotF.processedPayments[paymentIdF1].orderId === orderF1Id, 'Test F: Original payment record for paymentIdF1 still points strictly to Order F1');
    assert(currentDbSnapshotF.processedPayments[paymentIdF2].orderId === orderF2Id, 'Test F: Payment record for paymentIdF2 unchanged (zero overwrite)');

    // TEST G: Completed Order Missing Identity
    console.log('\n  [TEST G]: Completed order missing identity fail-closed rejection');
    const orderGRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 43,
      tableName: 'Table 43',
      customerPhone: '9876543233',
      customerName: 'G User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderGId = orderGRes.data.id;
    const payOrderGRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderGId });
    const rzpOrderGId = payOrderGRes.data.razorpayOrderId;
    const paymentIdG = `pay_g_legit_${Date.now()}`;
    const sigG = computeCheckoutSignature(rzpOrderGId, paymentIdG);

    // Settle Order G
    const settleGRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderGId,
      razorpay_order_id: rzpOrderGId,
      razorpay_payment_id: paymentIdG,
      razorpay_signature: sigG
    });
    assert(settleGRes.statusCode === 200, 'Test G: Order G settled successfully');

    // Complete Order G
    await makeRequest('PATCH', `/api/orders/${orderGId}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });

    // G1: Missing txnId simulation on completed order via webhook
    const missingTxnWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdG + '_sim_notxn',
            order_id: rzpOrderGId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const missingTxnWhSig = computeWebhookSignature(missingTxnWhPayload);
    const missingTxnWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': missingTxnWhSig,
      'x-razorpay-event-id': `evt_g_notxn_${Date.now()}`
    }, missingTxnWhPayload);
    assert(missingTxnWhRes.statusCode === 400, 'Test G1: Completed order with missing txnId rejected with HTTP 400');
    assert(missingTxnWhRes.data.error && missingTxnWhRes.data.error.includes('Missing persisted txnId'), 'Test G1: Error confirms missing txnId rejected');

    // G2: Missing paymentDetails.paymentId simulation on completed order via webhook
    const missingDetailsWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdG + '_sim_nopaydetails',
            order_id: rzpOrderGId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const missingDetailsWhSig = computeWebhookSignature(missingDetailsWhPayload);
    const missingDetailsWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': missingDetailsWhSig,
      'x-razorpay-event-id': `evt_g_nopaydetails_${Date.now()}`
    }, missingDetailsWhPayload);
    assert(missingDetailsWhRes.statusCode === 400, 'Test G2: Completed order with missing paymentDetails.paymentId rejected with HTTP 400');
    assert(missingDetailsWhRes.data.error && missingDetailsWhRes.data.error.includes('Missing persisted paymentDetails'), 'Test G2: Error confirms missing paymentDetails rejected');

    // G3: Missing processedPayments record simulation on completed order via webhook
    const missingProcessedWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdG + '_sim_noprocessed',
            order_id: rzpOrderGId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const missingProcessedWhSig = computeWebhookSignature(missingProcessedWhPayload);
    const missingProcessedWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': missingProcessedWhSig,
      'x-razorpay-event-id': `evt_g_noprocessed_${Date.now()}`
    }, missingProcessedWhPayload);
    assert(missingProcessedWhRes.statusCode === 400, 'Test G3: Completed order with missing processedPayments entry rejected with HTTP 400');
    assert(missingProcessedWhRes.data.error && missingProcessedWhRes.data.error.includes('No matching processedPayments entry found'), 'Test G3: Error confirms missing processedPayments entry rejected');

    // Verify no payment record created or reassigned for any simulated invalid payment ID
    const currentDbSnapshotG = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!currentDbSnapshotG.processedPayments[paymentIdG + '_sim_notxn'], 'Test G: No processedPayments entry created for simulated missing txnId');
    assert(!currentDbSnapshotG.processedPayments[paymentIdG + '_sim_nopaydetails'], 'Test G: No processedPayments entry created for simulated missing paymentDetails');
    assert(!currentDbSnapshotG.processedPayments[paymentIdG + '_sim_noprocessed'], 'Test G: No processedPayments entry created for simulated missing processedPayments');

    // TEST H: Legitimate Completed-Order Retry
    console.log('\n  [TEST H]: Legitimate completed-order retry');
    // Get customer CRM before retry
    const custHStateBefore = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custHBefore = (custHStateBefore.data.customers || []).find(c => c.phone === '9876543233');
    const spentHBefore = custHBefore ? (custHBefore.totalSpent || 0) : 0;
    const pointsHBefore = custHBefore ? (custHBefore.loyaltyPoints || 0) : 0;

    // Retry exact original payment ID for Order G via webhook
    const legitRetryWhPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdG,
            order_id: rzpOrderGId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const legitRetryWhSig = computeWebhookSignature(legitRetryWhPayload);
    const legitRetryWhRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': legitRetryWhSig,
      'x-razorpay-event-id': `evt_h_legit_${Date.now()}`
    }, legitRetryWhPayload);

    assert(legitRetryWhRes.statusCode === 200, 'Test H: Legitimate completed-order retry returns HTTP 200');
    assert(legitRetryWhRes.data.status === 'ok' && legitRetryWhRes.data.settled === true && legitRetryWhRes.data.alreadySettled === true, 'Test H: Webhook response confirms settled: true, alreadySettled: true');

    // Also retry via verify-signature
    const legitRetryCheckoutRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderGId,
      razorpay_order_id: rzpOrderGId,
      razorpay_payment_id: paymentIdG,
      razorpay_signature: sigG
    });
    assert(legitRetryCheckoutRes.statusCode === 200, 'Test H: Verify-signature retry on completed order returns HTTP 200');
    assert(legitRetryCheckoutRes.data.verified === true && legitRetryCheckoutRes.data.alreadySettled === true, 'Test H: Verify-signature response confirms verified: true, alreadySettled: true');

    // Customer spend and loyalty points must remain unchanged
    const custHStateAfter = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custHAfter = (custHStateAfter.data.customers || []).find(c => c.phone === '9876543233');
    const spentHAfter = custHAfter ? (custHAfter.totalSpent || 0) : 0;
    const pointsHAfter = custHAfter ? (custHAfter.loyaltyPoints || 0) : 0;
    assert(spentHAfter === spentHBefore, `Test H: Customer spend remained exactly unchanged (${spentHBefore}), got ${spentHAfter}`);
    assert(pointsHAfter === pointsHBefore, `Test H: Customer loyalty points remained exactly unchanged (${pointsHBefore}), got ${pointsHAfter}`);

    // TEST I: Concurrent Cross-Order Replay
    console.log('\n  [TEST I]: Concurrent cross-order replay with completed order');
    const orderI1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 44,
      tableName: 'Table 44',
      customerPhone: '9876543234',
      customerName: 'I1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderI1Id = orderI1Res.data.id;
    const payOrderI1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderI1Id });
    const rzpOrderI1Id = payOrderI1Res.data.razorpayOrderId;
    const paymentIdI = `pay_race_comp_${Date.now()}`;
    const sigI1 = computeCheckoutSignature(rzpOrderI1Id, paymentIdI);

    // Settle and complete Order I1
    await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderI1Id,
      razorpay_order_id: rzpOrderI1Id,
      razorpay_payment_id: paymentIdI,
      razorpay_signature: sigI1
    });
    await makeRequest('PATCH', `/api/orders/${orderI1Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });

    // Create Order I2 (unsettled active order)
    const orderI2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 45,
      tableName: 'Table 45',
      customerPhone: '9876543235',
      customerName: 'I2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderI2Id = orderI2Res.data.id;
    const payOrderI2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderI2Id });
    const rzpOrderI2Id = payOrderI2Res.data.razorpayOrderId;
    const sigI2 = computeCheckoutSignature(rzpOrderI2Id, paymentIdI);

    // Fire concurrent attempts: Request 1 = legitimate completed retry for Order I1, Request 2 = attempt to settle Order I2 with same paymentIdI
    const [raceI1Res, raceI2Res] = await Promise.all([
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
        orderId: orderI1Id,
        razorpay_order_id: rzpOrderI1Id,
        razorpay_payment_id: paymentIdI,
        razorpay_signature: sigI1
      }),
      makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
        orderId: orderI2Id,
        razorpay_order_id: rzpOrderI2Id,
        razorpay_payment_id: paymentIdI,
        razorpay_signature: sigI2
      })
    ]);

    assert(raceI1Res.statusCode === 200 && raceI1Res.data.verified === true, 'Test I: Legitimate completed Order I1 retry accepted with HTTP 200');
    assert(raceI2Res.statusCode === 400, 'Test I: Concurrent attempt by Order I2 to claim Order I1 payment ID rejected with HTTP 400');
    assert(raceI2Res.data.verified !== true && raceI2Res.data.success !== true, 'Test I: Losing request receives no false success response');

    // Verify Order I2 remains unpaid
    const checkI2State = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderI2Id}`);
    const ordI2Doc = (checkI2State.data.orders || []).find(o => o.id === orderI2Id);
    assert(ordI2Doc && ordI2Doc.isPaid === false, 'Test I: Order I2 remains unpaid (isPaid: false) in database');

    // Verify customer spend on Order I2 is 0
    const custIState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custI2 = (custIState.data.customers || []).find(c => c.phone === '9876543235');
    assert((custI2 ? custI2.totalSpent : 0) === 0, 'Test I: Zero customer spend for rejected settlement');

    // TEST J: Cross-Tenant Completed-Order Isolation
    console.log('\n  [TEST J]: Cross-tenant completed-order isolation');
    const orderJ1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 46,
      tableName: 'Table 46',
      customerPhone: '9876543236',
      customerName: 'J1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderJ1Id = orderJ1Res.data.id;
    const payOrderJ1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJ1Id });
    const rzpOrderJ1Id = payOrderJ1Res.data.razorpayOrderId;
    const paymentIdJ = `pay_tenant_comp_${Date.now()}`;
    const sigJ1 = computeCheckoutSignature(rzpOrderJ1Id, paymentIdJ);

    // Settle and complete Order J1 on tiptap-bistro
    await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderJ1Id,
      razorpay_order_id: rzpOrderJ1Id,
      razorpay_payment_id: paymentIdJ,
      razorpay_signature: sigJ1
    });
    await makeRequest('PATCH', `/api/orders/${orderJ1Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });

    // Create Order J2 on sharma-dhaba
    const orderJ2Res = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {}, {
      tableId: 2,
      tableName: 'Table 2',
      customerPhone: '9876543237',
      customerName: 'J2 User',
      items: [{ id: 'sharma-dhaba_m1', qty: 1 }] // price 280, total 294
    });
    const orderJ2Id = orderJ2Res.data.id;
    const payOrderJ2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=sharma-dhaba', {}, { orderId: orderJ2Id });
    const rzpOrderJ2Id = payOrderJ2Res.data.razorpayOrderId;
    const sigJ2 = computeCheckoutSignature(rzpOrderJ2Id, paymentIdJ);

    // Attempt to process paymentIdJ (belonging to completed Order J1 on tiptap-bistro) on sharma-dhaba
    const crossTenantRetryRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=sharma-dhaba', {}, {
      orderId: orderJ2Id,
      razorpay_order_id: rzpOrderJ2Id,
      razorpay_payment_id: paymentIdJ,
      razorpay_signature: sigJ2
    });
    assert(crossTenantRetryRes.statusCode === 400, 'Test J: Attempt to reuse completed payment ID from another tenant rejected with HTTP 400');
    assert(crossTenantRetryRes.data.error && (crossTenantRetryRes.data.error.includes('Cannot settle multiple orders with same payment') || crossTenantRetryRes.data.error.includes('belongs to restaurant')), 'Test J: Error explains cross-tenant or duplicate consumption rejection');

    // Verify order and payment isolation
    const currentDbSnapshotJ = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(currentDbSnapshotJ.processedPayments[paymentIdJ].restaurantId === 'tiptap-bistro', 'Test J: Payment ID record strictly owned by tiptap-bistro');
    assert(currentDbSnapshotJ.processedPayments[paymentIdJ].orderId === orderJ1Id, 'Test J: Payment ID record strictly bound to Order J1');

    // Verify sharma-dhaba Order J2 remains unpaid
    const checkJ2State = await makeRequest('GET', `/api/state?restaurant=sharma-dhaba&orderId=${orderJ2Id}`);
    const ordJ2Doc = (checkJ2State.data.orders || []).find(o => o.id === orderJ2Id);
    assert(ordJ2Doc && ordJ2Doc.isPaid === false, 'Test J: sharma-dhaba Order J2 remains unpaid (isPaid: false)');

    // Verify sharma-dhaba customer spend was not mutated
    const custJState = await makeRequest('GET', '/api/state?restaurant=sharma-dhaba', { 'x-master-pin': 'SuperAdminPin#Phase10' });
    const custJ2 = (custJState.data.customers || []).find(c => c.phone === '9876543237');
    assert((custJ2 ? custJ2.totalSpent : 0) === 0, 'Test J: Zero customer spend mutation on sharma-dhaba');

    // ----------------------------------------------------
    // SECTION 9f: WEBHOOK EVENT ID OWNERSHIP REGRESSION TESTS (A THROUGH F)
    // ----------------------------------------------------
    console.log('\n--- 9f. WEBHOOK EVENT ID OWNERSHIP REGRESSION TESTS (A THROUGH F) ---');

    // Setup base orders for Section 9f
    // Order K1 on tiptap-bistro
    const orderK1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 47,
      tableName: 'Table 47',
      customerPhone: '9876543240',
      customerName: 'K1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderK1Id = orderK1Res.data.id;
    const payOrderK1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderK1Id });
    const rzpOrderK1Id = payOrderK1Res.data.razorpayOrderId;
    const paymentIdK1 = `pay_k1_legit_${Date.now()}`;
    const sigK1 = computeCheckoutSignature(rzpOrderK1Id, paymentIdK1);
    await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderK1Id,
      razorpay_order_id: rzpOrderK1Id,
      razorpay_payment_id: paymentIdK1,
      razorpay_signature: sigK1
    });
    await makeRequest('PATCH', `/api/orders/${orderK1Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });

    // Order K2 on tiptap-bistro (different order)
    const orderK2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 48,
      tableName: 'Table 48',
      customerPhone: '9876543241',
      customerName: 'K2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderK2Id = orderK2Res.data.id;
    const payOrderK2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderK2Id });
    const rzpOrderK2Id = payOrderK2Res.data.razorpayOrderId;
    const paymentIdK2 = `pay_k2_legit_${Date.now()}`;
    const sigK2 = computeCheckoutSignature(rzpOrderK2Id, paymentIdK2);
    await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: orderK2Id,
      razorpay_order_id: rzpOrderK2Id,
      razorpay_payment_id: paymentIdK2,
      razorpay_signature: sigK2
    });
    await makeRequest('PATCH', `/api/orders/${orderK2Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });

    // Order K3 on sharma-dhaba (different tenant)
    const orderK3Res = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {}, {
      tableId: 3,
      tableName: 'Table 3',
      customerPhone: '9876543242',
      customerName: 'K3 User',
      items: [{ id: 'sharma-dhaba_m1', qty: 1 }] // price 280, total 294
    });
    const orderK3Id = orderK3Res.data.id;
    const payOrderK3Res = await makeRequest('POST', '/api/create-payment-order?restaurant=sharma-dhaba', {}, { orderId: orderK3Id });
    const rzpOrderK3Id = payOrderK3Res.data.razorpayOrderId;
    const paymentIdK3 = `pay_k3_legit_${Date.now()}`;
    const sigK3 = computeCheckoutSignature(rzpOrderK3Id, paymentIdK3);
    await makeRequest('POST', '/api/payment/verify-signature?restaurant=sharma-dhaba', {}, {
      orderId: orderK3Id,
      razorpay_order_id: rzpOrderK3Id,
      razorpay_payment_id: paymentIdK3,
      razorpay_signature: sigK3
    });
    await makeRequest('PATCH', `/api/orders/${orderK3Id}?restaurant=sharma-dhaba`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });

    // Initial valid webhook event recorded for Order K1
    const eventIdK = `evt_k_ownership_${Date.now()}`;
    const whPayloadK1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdK1,
            order_id: rzpOrderK1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigK1 = computeWebhookSignature(whPayloadK1);
    const initialWhResK = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': eventIdK
    }, whPayloadK1);
    assert(initialWhResK.statusCode === 200, 'Section 9f: Initial webhook event recorded successfully');

    // TEST A: Same event ID, same order, same restaurant, same payment ID -> legitimate idempotent success
    console.log('\n  [TEST A]: Same event ID, same order, same restaurant, same payment ID');
    const retryResA = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': eventIdK
    }, whPayloadK1);
    assert(retryResA.statusCode === 200, 'Test A: Replay with matching event ID, order, restaurant, and payment ID returns HTTP 200');
    assert(retryResA.data.status === 'ok' && retryResA.data.settled === true && retryResA.data.alreadySettled === true, 'Test A: Response confirms alreadySettled: true');
    assert(retryResA.data.alreadyProcessed === true, 'Test A: Response confirms alreadyProcessed: true');

    // TEST B: Same event ID, different order -> reject
    console.log('\n  [TEST B]: Same event ID, different order rejection');
    const whPayloadK2 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdK2,
            order_id: rzpOrderK2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigK2 = computeWebhookSignature(whPayloadK2);
    const rejectOrderResB = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK2,
      'x-razorpay-event-id': eventIdK // re-using Order K1's event ID on Order K2!
    }, whPayloadK2);
    assert(rejectOrderResB.statusCode === 400, 'Test B: Webhook with same event ID but different order rejected with HTTP 400');
    assert(rejectOrderResB.data.error && rejectOrderResB.data.error.includes('ownership mismatch'), 'Test B: Error confirms event ownership mismatch');

    // Verify original event record in DB unchanged
    const dbSnapB = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(dbSnapB.processedWebhookEvents[eventIdK].orderId === orderK1Id, 'Test B: Original event record still points to orderK1Id');
    assert(dbSnapB.processedWebhookEvents[eventIdK].paymentId === paymentIdK1, 'Test B: Original event record paymentId unchanged');

    // TEST C: Same event ID, different restaurant -> reject
    console.log('\n  [TEST C]: Same event ID, different restaurant rejection');
    const whPayloadK3 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdK3,
            order_id: rzpOrderK3Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigK3 = computeWebhookSignature(whPayloadK3);
    const rejectRestResC = await makeRequest('POST', '/api/payment-webhook?restaurant=sharma-dhaba', {
      'x-razorpay-signature': whSigK3,
      'x-razorpay-event-id': eventIdK // using tiptap-bistro's event ID on sharma-dhaba!
    }, whPayloadK3);
    assert(rejectRestResC.statusCode === 400 || rejectRestResC.statusCode === 403, 'Test C: Webhook with same event ID but different restaurant rejected');
    assert(rejectRestResC.data.error && (rejectRestResC.data.error.includes('ownership mismatch') || rejectRestResC.data.error.includes('Cross-tenant')), 'Test C: Error confirms cross-tenant/ownership rejection');

    // Verify original event record restaurantId unchanged
    const dbSnapC = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(dbSnapC.processedWebhookEvents[eventIdK].restaurantId === 'tiptap-bistro', 'Test C: Original event record restaurantId strictly tiptap-bistro');

    // TEST D: Same event ID, different payment ID -> reject
    console.log('\n  [TEST D]: Same event ID, different payment ID rejection');
    const diffPayPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_different_${Date.now()}`,
            order_id: rzpOrderK1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const diffPaySig = computeWebhookSignature(diffPayPayload);
    const rejectPayResD = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': diffPaySig,
      'x-razorpay-event-id': eventIdK
    }, diffPayPayload);
    assert(rejectPayResD.statusCode === 400, 'Test D: Webhook with same event ID but different payment ID rejected with HTTP 400');
    assert(rejectPayResD.data.error && (rejectPayResD.data.error.includes('ownership mismatch') || rejectPayResD.data.error.includes('Conflicting payment ID')), 'Test D: Error confirms payment ID mismatch rejection');

    // TEST E: Existing event record missing orderId, restaurantId, or paymentId -> fail closed
    console.log('\n  [TEST E]: Corrupted/incomplete event record fail-closed rejection');
    // E1: Seed event missing orderId
    const evtMissingOrder = `evt_missing_orderId_${Date.now()}_seed_missing_orderId`;
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': evtMissingOrder
    }, whPayloadK1);
    const retryResE1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': evtMissingOrder
    }, whPayloadK1);
    assert(retryResE1.statusCode === 400, 'Test E1: Event record missing orderId rejected with HTTP 400');
    assert(retryResE1.data.error && retryResE1.data.error.includes('Missing persisted orderId'), 'Test E1: Error confirms missing orderId rejected');

    // E2: Seed event missing restaurantId
    const evtMissingRest = `evt_missing_restaurantId_${Date.now()}_seed_missing_restaurantId`;
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': evtMissingRest
    }, whPayloadK1);
    const retryResE2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': evtMissingRest
    }, whPayloadK1);
    assert(retryResE2.statusCode === 400, 'Test E2: Event record missing restaurantId rejected with HTTP 400');
    assert(retryResE2.data.error && retryResE2.data.error.includes('Missing persisted restaurantId'), 'Test E2: Error confirms missing restaurantId rejected');

    // E3: Seed event missing paymentId
    const evtMissingPay = `evt_missing_paymentId_${Date.now()}_seed_missing_paymentId`;
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': evtMissingPay
    }, whPayloadK1);
    const retryResE3 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigK1,
      'x-razorpay-event-id': evtMissingPay
    }, whPayloadK1);
    assert(retryResE3.statusCode === 400, 'Test E3: Event record missing paymentId rejected with HTTP 400');
    assert(retryResE3.data.error && retryResE3.data.error.includes('Missing persisted paymentId'), 'Test E3: Error confirms missing paymentId rejected');

    // TEST F: Concurrent requests using the same event ID but different ownership identities
    console.log('\n  [TEST F]: Concurrent conflicting event ID race');
    const eventIdF = `evt_concurrent_clash_${Date.now()}`;
    const [clashRes1, clashRes2] = await Promise.all([
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
        'x-razorpay-signature': whSigK1,
        'x-razorpay-event-id': eventIdF
      }, whPayloadK1),
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
        'x-razorpay-signature': whSigK2,
        'x-razorpay-event-id': eventIdF
      }, whPayloadK2)
    ]);

    const successResF = clashRes1.statusCode === 200 ? clashRes1 : (clashRes2.statusCode === 200 ? clashRes2 : null);
    const rejectedResF = clashRes1.statusCode === 400 ? clashRes1 : (clashRes2.statusCode === 400 ? clashRes2 : null);

    assert(successResF !== null, 'Test F: Exactly one concurrent request succeeds (HTTP 200)');
    assert(rejectedResF !== null, 'Test F: Conflicting concurrent request rejected with HTTP 400');
    assert(rejectedResF.data.error && (rejectedResF.data.error.includes('ownership mismatch') || rejectedResF.data.error.includes('already consumed')), 'Test F: Rejection confirms ownership mismatch or conflicting payment');

    // Verify original winner retains ownership without corruption
    const dbSnapF = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const finalEvtF = dbSnapF.processedWebhookEvents[eventIdF];
    assert(finalEvtF, 'Test F: Event record persisted in database');
    const winnerOrderIdF = (clashRes1.statusCode === 200) ? orderK1Id : orderK2Id;
    const winnerPaymentIdF = (clashRes1.statusCode === 200) ? paymentIdK1 : paymentIdK2;
    assert(finalEvtF.orderId === winnerOrderIdF, 'Test F: Event record strictly bound to winner orderId');
    assert(finalEvtF.paymentId === winnerPaymentIdF, 'Test F: Event record strictly bound to winner paymentId');

    // Customer spend & loyalty integrity for all participants
    const custK1State = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custK1 = (custK1State.data.customers || []).find(c => c.phone === '9876543240');
    assert(custK1.totalSpent === 294, 'Test F: Customer K1 spend exactly unchanged (294)');
    assert(custK1.loyaltyPoints === 29, 'Test F: Customer K1 loyalty points exactly unchanged (29)');

    const custK2 = (custK1State.data.customers || []).find(c => c.phone === '9876543241');
    assert(custK2.totalSpent === 294, 'Test F: Customer K2 spend exactly unchanged (294)');
    assert(custK2.loyaltyPoints === 29, 'Test F: Customer K2 loyalty points exactly unchanged (29)');

    // ----------------------------------------------------
    // SECTION 9g: ACTIVE-ORDER WEBHOOK EVENT ID OWNERSHIP REGRESSION TESTS (A THROUGH G)
    // ----------------------------------------------------
    console.log('\n--- 9g. ACTIVE-ORDER WEBHOOK EVENT ID OWNERSHIP REGRESSION TESTS (A THROUGH G) ---');

    // Base active orders for Section 9g (dining orders on tables, not marked served)
    // Active Order L1 on tiptap-bistro
    const orderL1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 49,
      tableName: 'Table 49',
      customerPhone: '9876543250',
      customerName: 'L1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderL1Id = orderL1Res.data.id;
    const payOrderL1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderL1Id });
    const rzpOrderL1Id = payOrderL1Res.data.razorpayOrderId;
    const paymentIdL1 = `pay_l1_active_${Date.now()}`;

    // Active Order L2 on tiptap-bistro
    const orderL2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 50,
      tableName: 'Table 50',
      customerPhone: '9876543251',
      customerName: 'L2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderL2Id = orderL2Res.data.id;
    const payOrderL2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderL2Id });
    const rzpOrderL2Id = payOrderL2Res.data.razorpayOrderId;
    const paymentIdL2 = `pay_l2_active_${Date.now()}`;

    // Active Order L3 on sharma-dhaba
    const orderL3Res = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {}, {
      tableId: 5,
      tableName: 'Table 5',
      customerPhone: '9876543252',
      customerName: 'L3 User',
      items: [{ id: 'sharma-dhaba_m1', qty: 1 }] // price 280, total 294
    });
    const orderL3Id = orderL3Res.data.id;
    const payOrderL3Res = await makeRequest('POST', '/api/create-payment-order?restaurant=sharma-dhaba', {}, { orderId: orderL3Id });
    const rzpOrderL3Id = payOrderL3Res.data.razorpayOrderId;
    const paymentIdL3 = `pay_l3_active_${Date.now()}`;

    // Initial valid webhook settling Active Order L1
    const eventIdL = `evt_l_active_${Date.now()}`;
    const whPayloadL1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdL1,
            order_id: rzpOrderL1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigL1 = computeWebhookSignature(whPayloadL1);
    const initialWhResL = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigL1,
      'x-razorpay-event-id': eventIdL
    }, whPayloadL1);
    assert(initialWhResL.statusCode === 200, 'Section 9g: Initial active order webhook event recorded successfully');
    assert(initialWhResL.data.settled === true, 'Section 9g: Active Order L1 settled successfully');

    // TEST A: Same event ID + same active order + same restaurant + same payment -> legitimate idempotent retry
    console.log('\n  [TEST A]: Active order same event ID, order, restaurant, payment ID');
    const retryResAL = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigL1,
      'x-razorpay-event-id': eventIdL
    }, whPayloadL1);
    assert(retryResAL.statusCode === 200, 'Test A (Active): Replay with matching active event ID returns HTTP 200');
    assert(retryResAL.data.alreadyProcessed === true, 'Test A (Active): Response confirms alreadyProcessed: true');

    // Customer spend & loyalty must not increment on retry
    const custL1State = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custL1 = (custL1State.data.customers || []).find(c => c.phone === '9876543250');
    assert(custL1.totalSpent === 294, 'Test A (Active): Customer L1 spend not duplicated on retry (294)');
    assert(custL1.loyaltyPoints === 29, 'Test A (Active): Customer L1 loyalty points not duplicated (29)');

    // TEST B: Same event ID + different active order -> reject
    console.log('\n  [TEST B]: Active order same event ID, different active order rejection');
    const whPayloadL2 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdL2,
            order_id: rzpOrderL2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigL2 = computeWebhookSignature(whPayloadL2);
    const rejectOrderResBL = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigL2,
      'x-razorpay-event-id': eventIdL // using Order L1's eventId on active Order L2!
    }, whPayloadL2);
    assert(rejectOrderResBL.statusCode === 400, 'Test B (Active): Webhook with same event ID but different active order rejected with HTTP 400');
    assert(rejectOrderResBL.data.error && rejectOrderResBL.data.error.includes('ownership mismatch'), 'Test B (Active): Error confirms event ownership mismatch');

    // Verify Active Order L2 remains unpaid
    const checkL2State = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderL2Id}`);
    const ordL2Doc = (checkL2State.data.orders || []).find(o => o.id === orderL2Id);
    assert(ordL2Doc && ordL2Doc.isPaid === false, 'Test B (Active): Order L2 remains unpaid (isPaid: false)');

    // Verify original event record in DB still belongs to Order L1
    const dbSnapBL = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(dbSnapBL.processedWebhookEvents[eventIdL].orderId === orderL1Id, 'Test B (Active): Original event record strictly points to orderL1Id');
    assert(dbSnapBL.processedWebhookEvents[eventIdL].paymentId === paymentIdL1, 'Test B (Active): Original event record paymentId strictly paymentIdL1');

    // TEST C: Same event ID + different restaurant -> reject
    console.log('\n  [TEST C]: Active order same event ID, different restaurant rejection');
    const whPayloadL3 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdL3,
            order_id: rzpOrderL3Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigL3 = computeWebhookSignature(whPayloadL3);
    const rejectRestResCL = await makeRequest('POST', '/api/payment-webhook?restaurant=sharma-dhaba', {
      'x-razorpay-signature': whSigL3,
      'x-razorpay-event-id': eventIdL // using tiptap-bistro's eventId on sharma-dhaba!
    }, whPayloadL3);
    assert(rejectRestResCL.statusCode === 400 || rejectRestResCL.statusCode === 403, 'Test C (Active): Webhook with same event ID but different restaurant rejected');
    assert(rejectRestResCL.data.error && (rejectRestResCL.data.error.includes('ownership mismatch') || rejectRestResCL.data.error.includes('Cross-tenant')), 'Test C (Active): Error confirms cross-tenant/ownership rejection');

    // Verify Order L3 remains unpaid
    const checkL3State = await makeRequest('GET', `/api/state?restaurant=sharma-dhaba&orderId=${orderL3Id}`);
    const ordL3Doc = (checkL3State.data.orders || []).find(o => o.id === orderL3Id);
    assert(ordL3Doc && ordL3Doc.isPaid === false, 'Test C (Active): sharma-dhaba Order L3 remains unpaid (isPaid: false)');

    // TEST D: Same event ID + different payment ID -> reject
    console.log('\n  [TEST D]: Active order same event ID, different payment ID rejection');
    const diffPayPayloadL = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_diff_active_${Date.now()}`,
            order_id: rzpOrderL1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const diffPaySigL = computeWebhookSignature(diffPayPayloadL);
    const rejectPayResDL = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': diffPaySigL,
      'x-razorpay-event-id': eventIdL
    }, diffPayPayloadL);
    assert(rejectPayResDL.statusCode === 400, 'Test D (Active): Webhook with same event ID but different payment ID rejected with HTTP 400');
    assert(rejectPayResDL.data.error && (rejectPayResDL.data.error.includes('ownership mismatch') || rejectPayResDL.data.error.includes('already settled with payment ID')), 'Test D (Active): Error confirms payment mismatch');

    // TEST E: Existing event record with missing orderId, restaurantId, or paymentId -> reject
    console.log('\n  [TEST E]: Active order incomplete event record fail-closed rejection');
    // E1: Missing orderId in existing event record
    const orderE1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 51,
      tableName: 'Table 51',
      customerPhone: '9876543261',
      customerName: 'E1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderE1Id = orderE1Res.data.id;
    const payOrderE1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderE1Id });
    const rzpOrderE1Id = payOrderE1Res.data.razorpayOrderId;
    const paymentIdE1 = `pay_e1_${Date.now()}`;
    const evtMissingOrderL = `evt_act_missing_orderId_${Date.now()}_seed_missing_orderId`;
    const whPayloadE1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdE1,
            order_id: rzpOrderE1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigE1 = computeWebhookSignature(whPayloadE1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigE1,
      'x-razorpay-event-id': evtMissingOrderL
    }, whPayloadE1);
    const retryResE1L = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigE1,
      'x-razorpay-event-id': evtMissingOrderL
    }, whPayloadE1);
    assert(retryResE1L.statusCode === 400, 'Test E1 (Active): Event record missing orderId rejected with HTTP 400');
    assert(retryResE1L.data.error && retryResE1L.data.error.includes('Missing persisted orderId'), 'Test E1 (Active): Error confirms missing orderId rejected');

    // E2: Missing restaurantId in existing event record
    const orderE2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 52,
      tableName: 'Table 52',
      customerPhone: '9876543262',
      customerName: 'E2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderE2Id = orderE2Res.data.id;
    const payOrderE2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderE2Id });
    const rzpOrderE2Id = payOrderE2Res.data.razorpayOrderId;
    const paymentIdE2 = `pay_e2_${Date.now()}`;
    const evtMissingRestL = `evt_act_missing_restaurantId_${Date.now()}_seed_missing_restaurantId`;
    const whPayloadE2 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdE2,
            order_id: rzpOrderE2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigE2 = computeWebhookSignature(whPayloadE2);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigE2,
      'x-razorpay-event-id': evtMissingRestL
    }, whPayloadE2);
    const retryResE2L = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigE2,
      'x-razorpay-event-id': evtMissingRestL
    }, whPayloadE2);
    assert(retryResE2L.statusCode === 400, 'Test E2 (Active): Event record missing restaurantId rejected with HTTP 400');
    assert(retryResE2L.data.error && retryResE2L.data.error.includes('Missing persisted restaurantId'), 'Test E2 (Active): Error confirms missing restaurantId rejected');

    // E3: Missing paymentId in existing event record
    const orderE3Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 53,
      tableName: 'Table 53',
      customerPhone: '9876543263',
      customerName: 'E3 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderE3Id = orderE3Res.data.id;
    const payOrderE3Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderE3Id });
    const rzpOrderE3Id = payOrderE3Res.data.razorpayOrderId;
    const paymentIdE3 = `pay_e3_${Date.now()}`;
    const evtMissingPayL = `evt_act_missing_paymentId_${Date.now()}_seed_missing_paymentId`;
    const whPayloadE3 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdE3,
            order_id: rzpOrderE3Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigE3 = computeWebhookSignature(whPayloadE3);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigE3,
      'x-razorpay-event-id': evtMissingPayL
    }, whPayloadE3);
    const retryResE3L = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigE3,
      'x-razorpay-event-id': evtMissingPayL
    }, whPayloadE3);
    assert(retryResE3L.statusCode === 400, 'Test E3 (Active): Event record missing paymentId rejected with HTTP 400');
    assert(retryResE3L.data.error && retryResE3L.data.error.includes('Missing persisted paymentId'), 'Test E3 (Active): Error confirms missing paymentId rejected');

    // TEST F: Concurrent active-order requests with the same event ID but conflicting ownership
    console.log('\n  [TEST F]: Concurrent active conflicting event ID race');
    // Ensure Table 1 and Table 2 are free of active orders before running race
    const stateBeforeF = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const existingOrd1 = (stateBeforeF.data.orders || []).find(o => o.tableId === 1 && !o.isPaid);
    if (existingOrd1) {
      await makeRequest('DELETE', `/api/orders/${existingOrd1.id}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' });
    }
    const existingOrd2 = (stateBeforeF.data.orders || []).find(o => o.tableId === 2 && !o.isPaid);
    if (existingOrd2) {
      await makeRequest('DELETE', `/api/orders/${existingOrd2.id}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' });
    }

    // Setup fresh active orders L5 and L6 on real tables 1 and 2
    const orderL5Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 1,
      tableName: 'Table 1',
      customerPhone: '9876543255',
      customerName: 'L5 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderL5Id = orderL5Res.data.id;
    const payOrderL5Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderL5Id });
    const rzpOrderL5Id = payOrderL5Res.data.razorpayOrderId;
    const paymentIdL5 = `pay_l5_race_${Date.now()}`;

    const orderL6Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 2,
      tableName: 'Table 2',
      customerPhone: '9876543256',
      customerName: 'L6 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderL6Id = orderL6Res.data.id;
    const payOrderL6Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderL6Id });
    const rzpOrderL6Id = payOrderL6Res.data.razorpayOrderId;
    const paymentIdL6 = `pay_l6_race_${Date.now()}`;

    const eventIdRace = `evt_race_active_${Date.now()}`;

    const whPayloadL5 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdL5,
            order_id: rzpOrderL5Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigL5 = computeWebhookSignature(whPayloadL5);

    const whPayloadL6 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdL6,
            order_id: rzpOrderL6Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigL6 = computeWebhookSignature(whPayloadL6);

    const [raceRes1, raceRes2] = await Promise.all([
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
        'x-razorpay-signature': whSigL5,
        'x-razorpay-event-id': eventIdRace
      }, whPayloadL5),
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
        'x-razorpay-signature': whSigL6,
        'x-razorpay-event-id': eventIdRace
      }, whPayloadL6)
    ]);

    const winnerRaceResL = raceRes1.statusCode === 200 ? raceRes1 : (raceRes2.statusCode === 200 ? raceRes2 : null);
    const loserRaceResL = raceRes1.statusCode === 400 ? raceRes1 : (raceRes2.statusCode === 400 ? raceRes2 : null);

    assert(winnerRaceResL !== null, 'Test F (Active): Exactly one concurrent request succeeds with HTTP 200');
    assert(loserRaceResL !== null, 'Test F (Active): Conflicting concurrent request rejected with HTTP 400');
    assert(loserRaceResL.data.error && (loserRaceResL.data.error.includes('ownership mismatch') || loserRaceResL.data.error.includes('already consumed')), 'Test F (Active): Rejection confirms ownership mismatch or conflicting payment');

    // TEST G: Verify rejected requests do not mutate payment records, customer spend, loyalty, order state, tables, or SSE events
    console.log('\n  [TEST G]: Verify rejected request zero side effects on all state');
    const dbSnapRace = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const finalEvtRace = dbSnapRace.processedWebhookEvents[eventIdRace];
    assert(finalEvtRace, 'Test G: Event record persisted in database');

    const winnerOrderId = (raceRes1.statusCode === 200) ? orderL5Id : orderL6Id;
    const winnerPaymentId = (raceRes1.statusCode === 200) ? paymentIdL5 : paymentIdL6;
    const loserOrderId = (raceRes1.statusCode === 200) ? orderL6Id : orderL5Id;
    const loserPhone = (raceRes1.statusCode === 200) ? '9876543256' : '9876543255';
    const loserTableId = (raceRes1.statusCode === 200) ? 2 : 1;

    assert(finalEvtRace.orderId === winnerOrderId, 'Test G: Event record strictly bound to winner orderId');
    assert(finalEvtRace.paymentId === winnerPaymentId, 'Test G: Event record strictly bound to winner paymentId');

    // Verify loser order document remains strictly unpaid
    const checkLoserState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${loserOrderId}`);
    const loserDoc = (checkLoserState.data.orders || []).find(o => o.id === loserOrderId);
    assert(loserDoc && loserDoc.isPaid === false, 'Test G: Loser order remains unpaid (isPaid: false)');
    assert(loserDoc && loserDoc.paymentStatus !== 'paid', 'Test G: Loser order paymentStatus is not paid');

    // Verify loser customer spend & loyalty points remain exactly 0
    const custLoserState = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custLoser = (custLoserState.data.customers || []).find(c => c.phone === loserPhone);
    assert((custLoser ? custLoser.totalSpent : 0) === 0, 'Test G: Loser customer spend remains 0 (zero mutation)');
    assert((custLoser ? custLoser.loyaltyPoints : 0) === 0, 'Test G: Loser customer loyalty points remain 0 (zero mutation)');

    // Verify loser table remains occupied by loser order (never transitioned to cleaning)
    const loserTable = (custLoserState.data.tables || []).find(t => t.id === loserTableId);
    assert(loserTable && loserTable.status === 'occupied', 'Test G: Loser table remains occupied');
    assert(loserTable && loserTable.currentOrderId === loserOrderId, 'Test G: Loser table still bound to loser order');

    // ----------------------------------------------------
    // SECTION 9h: ACTIVE-ORDER EVENT ID BINDING ON SETTLED PAYMENTS (A THROUGH F)
    // ----------------------------------------------------
    console.log('\n--- 9h. ACTIVE-ORDER EVENT ID BINDING ON SETTLED PAYMENTS (A THROUGH F) ---');

    // TEST A: First settlement of a payment, followed by a new event ID for the same payment and same order
    console.log('\n  [TEST A]: First settlement followed by new event ID binding on same active order');
    const orderM1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 56,
      tableName: 'Table 56',
      customerPhone: '9876543270',
      customerName: 'M1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderM1Id = orderM1Res.data.id;
    const payOrderM1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderM1Id });
    const rzpOrderM1Id = payOrderM1Res.data.razorpayOrderId;
    const paymentIdM1 = `pay_m1_${Date.now()}`;
    const eventIdM1A = `evt_m1a_${Date.now()}`;

    const whPayloadM1A = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdM1,
            order_id: rzpOrderM1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM1A = computeWebhookSignature(whPayloadM1A);
    const whResM1A = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigM1A,
      'x-razorpay-event-id': eventIdM1A
    }, whPayloadM1A);
    assert(whResM1A.statusCode === 200, 'Test A (9h): First settlement succeeds with HTTP 200');
    assert(whResM1A.data.settled === true, 'Test A (9h): Order M1 settled on first webhook');

    // Now send a SECOND webhook with a NEW event ID for the SAME already-settled payment and order
    const eventIdM1B = `evt_m1b_${Date.now()}`;
    const whPayloadM1B = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdM1,
            order_id: rzpOrderM1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM1B = computeWebhookSignature(whPayloadM1B);
    const whResM1B = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigM1B,
      'x-razorpay-event-id': eventIdM1B
    }, whPayloadM1B);
    assert(whResM1B.statusCode === 200, 'Test A (9h): Second webhook with new event ID on settled payment returns HTTP 200');
    assert(whResM1B.data.alreadySettled === true, 'Test A (9h): Response confirms order was already settled');

    // Verify eventIdM1B is persisted in the database with all three identity fields
    const dbSnapM1 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const persistedEvtM1B = dbSnapM1.processedWebhookEvents[eventIdM1B];
    assert(persistedEvtM1B, 'Test A (9h): New event ID on already-settled payment is persisted in database');
    assert(persistedEvtM1B.orderId === orderM1Id, 'Test A (9h): Persisted event record orderId matches orderM1Id');
    assert(persistedEvtM1B.restaurantId === 'tiptap-bistro', 'Test A (9h): Persisted event record restaurantId matches tiptap-bistro');
    assert(persistedEvtM1B.paymentId === paymentIdM1, 'Test A (9h): Persisted event record paymentId matches paymentIdM1');

    // Verify customer spend is not duplicated
    const custM1State = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custM1 = (custM1State.data.customers || []).find(c => c.phone === '9876543270');
    assert(custM1 && custM1.totalSpent === 294, 'Test A (9h): Customer M1 spend not duplicated (294)');
    assert(custM1 && custM1.loyaltyPoints === 29, 'Test A (9h): Customer M1 loyalty points not duplicated (29)');

    // TEST B: Reuse that newly persisted event ID against a different order -> HTTP 400
    console.log('\n  [TEST B]: Reuse newly persisted event ID against different order rejection');
    const orderM2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 57,
      tableName: 'Table 57',
      customerPhone: '9876543271',
      customerName: 'M2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderM2Id = orderM2Res.data.id;
    const payOrderM2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderM2Id });
    const rzpOrderM2Id = payOrderM2Res.data.razorpayOrderId;
    const paymentIdM2 = `pay_m2_${Date.now()}`;

    const whPayloadM2 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdM2,
            order_id: rzpOrderM2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM2 = computeWebhookSignature(whPayloadM2);
    const rejectM2Res = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigM2,
      'x-razorpay-event-id': eventIdM1B // reusing eventIdM1B!
    }, whPayloadM2);
    assert(rejectM2Res.statusCode === 400, 'Test B (9h): Reusing eventIdM1B against different order rejected with HTTP 400');
    assert(rejectM2Res.data.error && rejectM2Res.data.error.includes('ownership mismatch'), 'Test B (9h): Error confirms event ownership mismatch');

    // Verify Order M2 remains unpaid
    const checkM2State = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderM2Id}`);
    const ordM2Doc = (checkM2State.data.orders || []).find(o => o.id === orderM2Id);
    assert(ordM2Doc && ordM2Doc.isPaid === false, 'Test B (9h): Order M2 remains strictly unpaid');

    // TEST C: Reuse that event ID against a different restaurant -> rejection
    console.log('\n  [TEST C]: Reuse event ID against different restaurant cross-tenant rejection');
    const orderM3Res = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {}, {
      tableId: 6,
      tableName: 'Table 6',
      customerPhone: '9876543272',
      customerName: 'M3 User',
      items: [{ id: 'sharma-dhaba_m1', qty: 1 }] // total 294
    });
    const orderM3Id = orderM3Res.data.id;
    const payOrderM3Res = await makeRequest('POST', '/api/create-payment-order?restaurant=sharma-dhaba', {}, { orderId: orderM3Id });
    const rzpOrderM3Id = payOrderM3Res.data.razorpayOrderId;
    const paymentIdM3 = `pay_m3_${Date.now()}`;

    const whPayloadM3 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdM3,
            order_id: rzpOrderM3Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM3 = computeWebhookSignature(whPayloadM3);
    const rejectM3Res = await makeRequest('POST', '/api/payment-webhook?restaurant=sharma-dhaba', {
      'x-razorpay-signature': whSigM3,
      'x-razorpay-event-id': eventIdM1B // reusing eventIdM1B across restaurants!
    }, whPayloadM3);
    assert(rejectM3Res.statusCode === 400 || rejectM3Res.statusCode === 403, 'Test C (9h): Reusing eventIdM1B against different restaurant rejected');
    assert(rejectM3Res.data.error && (rejectM3Res.data.error.includes('ownership mismatch') || rejectM3Res.data.error.includes('Cross-tenant')), 'Test C (9h): Error confirms cross-tenant/ownership rejection');

    // Verify Order M3 remains unpaid
    const checkM3State = await makeRequest('GET', `/api/state?restaurant=sharma-dhaba&orderId=${orderM3Id}`);
    const ordM3Doc = (checkM3State.data.orders || []).find(o => o.id === orderM3Id);
    assert(ordM3Doc && ordM3Doc.isPaid === false, 'Test C (9h): sharma-dhaba Order M3 remains strictly unpaid');

    // TEST D: Concurrent requests where one uses already-processed payment and another claims same event ID for different order
    console.log('\n  [TEST D]: Concurrent already-processed payment vs different order claiming same event ID');
    // Clear tables 3 and 4
    const stateBeforeD = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    for (const ord of (stateBeforeD.data.orders || []).filter(o => o.tableId === 3 || o.tableId === 4)) {
      await makeRequest('DELETE', `/api/orders/${ord.id}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' });
    }

    // Setup Order M4 (will be pre-settled)
    const orderM4Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 3,
      tableName: 'Table 3',
      customerPhone: '9876543274',
      customerName: 'M4 User',
      notes: 'Test D Order M4',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderM4Id = orderM4Res.data.id;
    const payOrderM4Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderM4Id });
    const rzpOrderM4Id = payOrderM4Res.data.razorpayOrderId;
    const paymentIdM4 = `pay_m4_${Date.now()}`;
    const eventIdM4Init = `evt_m4_init_${Date.now()}`;

    // Settle Order M4 initially
    const whPayloadM4Init = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdM4,
            order_id: rzpOrderM4Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM4Init = computeWebhookSignature(whPayloadM4Init);
    const whResM4Init = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigM4Init,
      'x-razorpay-event-id': eventIdM4Init
    }, whPayloadM4Init);
    assert(whResM4Init.statusCode === 200, 'Test D (9h): Order M4 initial settlement succeeded');

    // Setup fresh Order M5 (unsettled)
    const orderM5Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 4,
      tableName: 'Table 4',
      customerPhone: '9876543275',
      customerName: 'M5 User',
      notes: 'Test D Order M5',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderM5Id = orderM5Res.data.id;
    const payOrderM5Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderM5Id });
    const rzpOrderM5Id = payOrderM5Res.data.razorpayOrderId;
    const paymentIdM5 = `pay_m5_${Date.now()}`;

    // Shared race event ID:
    const eventIdRaceM = `evt_race_m_${Date.now()}`;

    // Request 1: Order M4 with already-processed paymentIdM4 and eventIdRaceM
    const whPayloadM4Race = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdM4,
            order_id: rzpOrderM4Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM4Race = computeWebhookSignature(whPayloadM4Race);

    // Request 2: Order M5 with unsettled paymentIdM5 and eventIdRaceM
    const whPayloadM5Race = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdM5,
            order_id: rzpOrderM5Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigM5Race = computeWebhookSignature(whPayloadM5Race);

    const [raceRes1M, raceRes2M] = await Promise.all([
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
        'x-razorpay-signature': whSigM4Race,
        'x-razorpay-event-id': eventIdRaceM
      }, whPayloadM4Race),
      makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
        'x-razorpay-signature': whSigM5Race,
        'x-razorpay-event-id': eventIdRaceM
      }, whPayloadM5Race)
    ]);

    const winnerResM = raceRes1M.statusCode === 200 ? raceRes1M : (raceRes2M.statusCode === 200 ? raceRes2M : null);
    const loserResM = raceRes1M.statusCode === 400 ? raceRes1M : (raceRes2M.statusCode === 400 ? raceRes2M : null);
    assert(winnerResM !== null, 'Test D (9h): Exactly one concurrent request succeeds with HTTP 200');
    assert(loserResM !== null, 'Test D (9h): Conflicting concurrent request rejected with HTTP 400');
    assert(loserResM.data.error && (loserResM.data.error.includes('ownership mismatch') || loserResM.data.error.includes('already consumed')), 'Test D (9h): Rejection confirms ownership mismatch or conflicting payment');

    // TEST E: Verify rejected requests do not modify payment records, order state, customer spend, loyalty points, or tables
    console.log('\n  [TEST E]: Verify rejected request zero side effects on state');
    const dbSnapRaceM = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const finalEvtRaceM = dbSnapRaceM.processedWebhookEvents[eventIdRaceM];
    assert(finalEvtRaceM, 'Test E (9h): Event record persisted in database');

    const winnerOrderIdM = (raceRes1M.statusCode === 200) ? orderM4Id : orderM5Id;
    const winnerPaymentIdM = (raceRes1M.statusCode === 200) ? paymentIdM4 : paymentIdM5;
    const loserOrderIdM = (raceRes1M.statusCode === 200) ? orderM5Id : orderM4Id;
    const loserPhoneM = (raceRes1M.statusCode === 200) ? '9876543275' : '9876543274';

    assert(finalEvtRaceM.orderId === winnerOrderIdM, 'Test E (9h): Event record strictly bound to winner orderId');
    assert(finalEvtRaceM.paymentId === winnerPaymentIdM, 'Test E (9h): Event record strictly bound to winner paymentId');

    // If Order M5 lost: verify M5 remains strictly unpaid, customer M5 spend is 0, table 4 occupied
    if (loserOrderIdM === orderM5Id) {
      const checkM5State = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${orderM5Id}`);
      const m5Doc = (checkM5State.data.orders || []).find(o => o.id === orderM5Id);
      assert(m5Doc && m5Doc.isPaid === false, 'Test E (9h): Loser Order M5 remains unpaid');
      assert(m5Doc && m5Doc.paymentStatus !== 'paid', 'Test E (9h): Loser Order M5 paymentStatus is not paid');

      const custM5State = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
      const custM5 = (custM5State.data.customers || []).find(c => c.phone === loserPhoneM);
      assert((custM5 ? custM5.totalSpent : 0) === 0, 'Test E (9h): Loser Customer M5 spend remains 0');
      assert((custM5 ? custM5.loyaltyPoints : 0) === 0, 'Test E (9h): Loser Customer M5 loyalty points remain 0');

      const tableM5 = (custM5State.data.tables || []).find(t => t.id === 4);
      assert(tableM5 && tableM5.status === 'occupied', 'Test E (9h): Table 4 remains occupied');
      assert(tableM5 && tableM5.currentOrderId === orderM5Id, 'Test E (9h): Table 4 still bound to Order M5');
    }

    // TEST F: Legitimate same-order idempotent retries still return HTTP 200 without duplicate spend or loyalty increments
    console.log('\n  [TEST F]: Legitimate same-order idempotent retries return HTTP 200 with zero duplicate spend');
    const retryResFM = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigM1B,
      'x-razorpay-event-id': eventIdM1B
    }, whPayloadM1B);
    assert(retryResFM.statusCode === 200, 'Test F (9h): Idempotent retry with eventIdM1B returns HTTP 200');
    assert(retryResFM.data.alreadyProcessed === true, 'Test F (9h): Response confirms alreadyProcessed: true');

    const custM1CheckFinal = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custM1Final = (custM1CheckFinal.data.customers || []).find(c => c.phone === '9876543270');
    assert(custM1Final && custM1Final.totalSpent === 294, 'Test F (9h): Customer M1 spend remains strictly 294 after retry');
    assert(custM1Final && custM1Final.loyaltyPoints === 29, 'Test F (9h): Customer M1 loyalty points remain strictly 29 after retry');

    // ----------------------------------------------------
    // SECTION 9i: STRICT PROCESSED PAYMENT & ALREADY-PAID ORDER IDENTITY (TESTS A THROUGH J)
    // ----------------------------------------------------
    console.log('\n--- 9i. STRICT PROCESSED PAYMENT & ALREADY-PAID ORDER IDENTITY (TESTS A THROUGH J) ---');

    // TEST A: Active order processed payment record missing orderId -> HTTP 400
    console.log('\n  [TEST A]: Active order processed payment record missing orderId rejection');
    const orderPARes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 61,
      tableName: 'Table 61',
      customerPhone: '9876543281',
      customerName: 'PA User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // total 294
    });
    const orderPAId = orderPARes.data.id;
    const payOrderPARes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPAId });
    const rzpOrderPAId = payOrderPARes.data.razorpayOrderId;
    const paymentIdPA = `pay_pa_${Date.now()}_seed_missing_pay_orderId`;
    const eventIdPA1 = `evt_pa1_${Date.now()}`;

    // Settle Order PA (seeded with missing orderId in processedPayments)
    const whPayloadPA1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPA,
            order_id: rzpOrderPAId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPA1 = computeWebhookSignature(whPayloadPA1);
    const whResPA1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPA1,
      'x-razorpay-event-id': eventIdPA1
    }, whPayloadPA1);
    assert(whResPA1.statusCode === 200, 'Test A (9i): Order PA initial settlement succeeded');

    // Second webhook with new event ID on the corrupted processedPayment record -> reject with HTTP 400
    const eventIdPA2 = `evt_pa2_${Date.now()}`;
    const whPayloadPA2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPA,
            order_id: rzpOrderPAId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPA2 = computeWebhookSignature(whPayloadPA2);
    const whResPA2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPA2,
      'x-razorpay-event-id': eventIdPA2
    }, whPayloadPA2);
    assert(whResPA2.statusCode === 400, 'Test A (9i): Processed payment missing orderId rejected with HTTP 400');
    assert(whResPA2.data.error && whResPA2.data.error.includes('Missing persisted orderId'), 'Test A (9i): Error confirms missing orderId rejected');

    // Verify zero side effects
    const dbSnapPA = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPA.processedWebhookEvents[eventIdPA2], 'Test A (9i): No new webhook event record created for rejected request');
    const custPACheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custPA = (custPACheck.data.customers || []).find(c => c.phone === '9876543281');
    assert(custPA && custPA.totalSpent === 294, 'Test A (9i): Zero duplicate spend increment (294)');
    assert(custPA && custPA.loyaltyPoints === 29, 'Test A (9i): Zero duplicate loyalty increment (29)');

    // TEST B: Active order processed payment record missing restaurantId -> HTTP 400
    console.log('\n  [TEST B]: Active order processed payment record missing restaurantId rejection');
    const orderPBRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 62,
      tableName: 'Table 62',
      customerPhone: '9876543282',
      customerName: 'PB User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPBId = orderPBRes.data.id;
    const payOrderPBRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPBId });
    const rzpOrderPBId = payOrderPBRes.data.razorpayOrderId;
    const paymentIdPB = `pay_pb_${Date.now()}_seed_missing_pay_restaurantId`;
    const eventIdPB1 = `evt_pb1_${Date.now()}`;

    // Settle Order PB (seeded with missing restaurantId in processedPayments)
    const whPayloadPB1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPB,
            order_id: rzpOrderPBId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPB1 = computeWebhookSignature(whPayloadPB1);
    const whResPB1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPB1,
      'x-razorpay-event-id': eventIdPB1
    }, whPayloadPB1);
    assert(whResPB1.statusCode === 200, 'Test B (9i): Order PB initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400
    const eventIdPB2 = `evt_pb2_${Date.now()}`;
    const whPayloadPB2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPB,
            order_id: rzpOrderPBId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPB2 = computeWebhookSignature(whPayloadPB2);
    const whResPB2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPB2,
      'x-razorpay-event-id': eventIdPB2
    }, whPayloadPB2);
    assert(whResPB2.statusCode === 400, 'Test B (9i): Processed payment missing restaurantId rejected with HTTP 400');
    assert(whResPB2.data.error && whResPB2.data.error.includes('Missing persisted restaurantId'), 'Test B (9i): Error confirms missing restaurantId rejected');

    const dbSnapPB = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPB.processedWebhookEvents[eventIdPB2], 'Test B (9i): No new webhook event record created');
    const custPBCheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custPB = (custPBCheck.data.customers || []).find(c => c.phone === '9876543282');
    assert(custPB && custPB.totalSpent === 294, 'Test B (9i): Zero duplicate spend increment (294)');

    // TEST C: Active order processed payment record with empty identity values -> HTTP 400
    console.log('\n  [TEST C]: Active order processed payment record with empty identity values rejection');
    const orderPCRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 63,
      tableName: 'Table 63',
      customerPhone: '9876543283',
      customerName: 'PC User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPCId = orderPCRes.data.id;
    const payOrderPCRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPCId });
    const rzpOrderPCId = payOrderPCRes.data.razorpayOrderId;
    const paymentIdPC = `pay_pc_${Date.now()}_seed_empty_pay_identity`;
    const eventIdPC1 = `evt_pc1_${Date.now()}`;

    // Settle Order PC (seeded with empty identity strings in processedPayments)
    const whPayloadPC1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPC,
            order_id: rzpOrderPCId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPC1 = computeWebhookSignature(whPayloadPC1);
    const whResPC1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPC1,
      'x-razorpay-event-id': eventIdPC1
    }, whPayloadPC1);
    assert(whResPC1.statusCode === 200, 'Test C (9i): Order PC initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400
    const eventIdPC2 = `evt_pc2_${Date.now()}`;
    const whPayloadPC2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPC,
            order_id: rzpOrderPCId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPC2 = computeWebhookSignature(whPayloadPC2);
    const whResPC2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPC2,
      'x-razorpay-event-id': eventIdPC2
    }, whPayloadPC2);
    assert(whResPC2.statusCode === 400, 'Test C (9i): Processed payment with empty identity rejected with HTTP 400');
    assert(whResPC2.data.error && whResPC2.data.error.includes('Missing persisted orderId'), 'Test C (9i): Error confirms empty/missing identity rejected');

    const dbSnapPC = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPC.processedWebhookEvents[eventIdPC2], 'Test C (9i): No new webhook event record created');

    // TEST D: Active order already-paid order with missing txnId -> HTTP 400
    console.log('\n  [TEST D]: Active order already-paid order with missing txnId rejection');
    const orderPDRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 64,
      tableName: 'Table 64',
      customerPhone: '9876543284',
      customerName: 'PD User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPDId = orderPDRes.data.id;
    const payOrderPDRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPDId });
    const rzpOrderPDId = payOrderPDRes.data.razorpayOrderId;
    const paymentIdPD = `pay_pd_${Date.now()}_seed_order_missing_txnId`;
    const eventIdPD1 = `evt_pd1_${Date.now()}`;

    // Settle Order PD (seeded with missing txnId on order)
    const whPayloadPD1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPD,
            order_id: rzpOrderPDId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPD1 = computeWebhookSignature(whPayloadPD1);
    const whResPD1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPD1,
      'x-razorpay-event-id': eventIdPD1
    }, whPayloadPD1);
    assert(whResPD1.statusCode === 200, 'Test D (9i): Order PD initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 because order.txnId is missing
    const eventIdPD2 = `evt_pd2_${Date.now()}`;
    const whPayloadPD2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPD,
            order_id: rzpOrderPDId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPD2 = computeWebhookSignature(whPayloadPD2);
    const whResPD2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPD2,
      'x-razorpay-event-id': eventIdPD2
    }, whPayloadPD2);
    assert(whResPD2.statusCode === 400, 'Test D (9i): Order with missing txnId rejected with HTTP 400');
    assert(whResPD2.data.error && whResPD2.data.error.includes('Missing persisted txnId'), 'Test D (9i): Error confirms missing txnId rejected');

    const dbSnapPD = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPD.processedWebhookEvents[eventIdPD2], 'Test D (9i): No new webhook event record created');

    // TEST E: Active order already-paid order with mismatched paymentDetails.paymentId -> HTTP 400
    console.log('\n  [TEST E]: Active order already-paid order with mismatched paymentDetails.paymentId rejection');
    const orderPERes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 65,
      tableName: 'Table 65',
      customerPhone: '9876543285',
      customerName: 'PE User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPEId = orderPERes.data.id;
    const payOrderPERes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPEId });
    const rzpOrderPEId = payOrderPERes.data.razorpayOrderId;
    const paymentIdPE = `pay_pe_${Date.now()}_seed_order_mismatched_payId`;
    const eventIdPE1 = `evt_pe1_${Date.now()}`;

    // Settle Order PE (seeded with mismatched paymentDetails.paymentId on order)
    const whPayloadPE1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPE,
            order_id: rzpOrderPEId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPE1 = computeWebhookSignature(whPayloadPE1);
    const whResPE1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPE1,
      'x-razorpay-event-id': eventIdPE1
    }, whPayloadPE1);
    assert(whResPE1.statusCode === 200, 'Test E (9i): Order PE initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 due to mismatched payment identity
    const eventIdPE2 = `evt_pe2_${Date.now()}`;
    const whPayloadPE2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPE,
            order_id: rzpOrderPEId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPE2 = computeWebhookSignature(whPayloadPE2);
    const whResPE2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPE2,
      'x-razorpay-event-id': eventIdPE2
    }, whPayloadPE2);
    assert(whResPE2.statusCode === 400, 'Test E (9i): Order with mismatched paymentDetails.paymentId rejected with HTTP 400');
    assert(whResPE2.data.error && (whResPE2.data.error.includes('Inconsistent persisted payment identity') || whResPE2.data.error.includes('already settled with payment ID')), 'Test E (9i): Error confirms mismatched payment identity rejected');

    const dbSnapPE = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPE.processedWebhookEvents[eventIdPE2], 'Test E (9i): No new webhook event record created');

    // TEST F: Completed order processed payment record missing restaurantId -> HTTP 400
    console.log('\n  [TEST F]: Completed order processed payment record missing restaurantId rejection');
    const orderPFRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 66,
      tableName: 'Table 66',
      customerPhone: '9876543286',
      customerName: 'PF User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPFId = orderPFRes.data.id;
    const payOrderPFRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPFId });
    const rzpOrderPFId = payOrderPFRes.data.razorpayOrderId;
    const paymentIdPF = `pay_pf_${Date.now()}_seed_missing_pay_restaurantId`;
    const eventIdPF1 = `evt_pf1_${Date.now()}`;

    // Settle Order PF
    const whPayloadPF1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPF,
            order_id: rzpOrderPFId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPF1 = computeWebhookSignature(whPayloadPF1);
    const whResPF1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPF1,
      'x-razorpay-event-id': eventIdPF1
    }, whPayloadPF1);
    assert(whResPF1.statusCode === 200, 'Test F (9i): Order PF initial settlement succeeded');

    // Move to completed orders via served kitchen status
    const servePFRes = await makeRequest('PATCH', `/api/orders/${orderPFId}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'served',
      kitchenStatus: 'served',
      staffPin: '1234'
    });
    assert(servePFRes.statusCode === 200 || servePFRes.statusCode === 204, 'Test F (9i): Order PF archived into completed orders');

    // Second webhook with new event ID -> reject with HTTP 400
    const eventIdPF2 = `evt_pf2_${Date.now()}`;
    const whPayloadPF2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPF,
            order_id: rzpOrderPFId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPF2 = computeWebhookSignature(whPayloadPF2);
    const whResPF2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPF2,
      'x-razorpay-event-id': eventIdPF2
    }, whPayloadPF2);
    assert(whResPF2.statusCode === 400, 'Test F (9i): Completed order processed payment missing restaurantId rejected with HTTP 400');
    assert(whResPF2.data.error && whResPF2.data.error.includes('Missing persisted restaurantId'), 'Test F (9i): Error confirms missing restaurantId rejected');

    const dbSnapPF = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPF.processedWebhookEvents[eventIdPF2], 'Test F (9i): No new webhook event record created');

    // TEST G: Completed order processed payment record with mismatched orderId -> HTTP 400
    console.log('\n  [TEST G]: Completed order processed payment record with mismatched orderId rejection');
    // Order PG1 (completed)
    const orderPG1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 67,
      tableName: 'Table 67',
      customerPhone: '9876543287',
      customerName: 'PG1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPG1Id = orderPG1Res.data.id;
    const payOrderPG1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPG1Id });
    const rzpOrderPG1Id = payOrderPG1Res.data.razorpayOrderId;
    const paymentIdPG1 = `pay_pg1_${Date.now()}`;
    const eventIdPG1 = `evt_pg1_${Date.now()}`;

    const whPayloadPG1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPG1,
            order_id: rzpOrderPG1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPG1 = computeWebhookSignature(whPayloadPG1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPG1,
      'x-razorpay-event-id': eventIdPG1
    }, whPayloadPG1);
    await makeRequest('PATCH', `/api/orders/${orderPG1Id}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' }, { status: 'served', kitchenStatus: 'served', staffPin: '1234' });

    // Order PG2 (completed)
    const orderPG2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 68,
      tableName: 'Table 68',
      customerPhone: '9876543288',
      customerName: 'PG2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPG2Id = orderPG2Res.data.id;
    const payOrderPG2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPG2Id });
    const rzpOrderPG2Id = payOrderPG2Res.data.razorpayOrderId;
    const paymentIdPG2 = `pay_pg2_${Date.now()}`;
    const eventIdPG2 = `evt_pg2_${Date.now()}`;

    const whPayloadPG2 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPG2,
            order_id: rzpOrderPG2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPG2 = computeWebhookSignature(whPayloadPG2);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPG2,
      'x-razorpay-event-id': eventIdPG2
    }, whPayloadPG2);
    await makeRequest('PATCH', `/api/orders/${orderPG2Id}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' }, { status: 'served', kitchenStatus: 'served', staffPin: '1234' });

    // Now attempt to settle/replay order PG2 using paymentIdPG1 (which belongs to PG1!)
    const eventIdPGClash = `evt_pg_clash_${Date.now()}`;
    const whPayloadPGClash = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPG1,
            order_id: rzpOrderPG2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPGClash = computeWebhookSignature(whPayloadPGClash);
    const whResPGClash = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPGClash,
      'x-razorpay-event-id': eventIdPGClash
    }, whPayloadPGClash);
    assert(whResPGClash.statusCode === 400, 'Test G (9i): Completed order with mismatched payment orderId rejected with HTTP 400');
    assert(whResPGClash.data.error && (whResPGClash.data.error.includes('already consumed by order') || whResPGClash.data.error.includes('already settled with payment ID')), 'Test G (9i): Error confirms payment already consumed by different order');

    const dbSnapPG = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPG.processedWebhookEvents[eventIdPGClash], 'Test G (9i): No new webhook event record created');

    // TEST H: Completed order processed payment record with mismatched restaurantId -> HTTP 400
    console.log('\n  [TEST H]: Completed order processed payment record with mismatched restaurantId rejection');
    // Order PH (completed in tiptap-bistro with mismatched restaurantId in processedPayments)
    const orderPHRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 69,
      tableName: 'Table 69',
      customerPhone: '9876543289',
      customerName: 'PH User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPHId = orderPHRes.data.id;
    const payOrderPHRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPHId });
    const rzpOrderPHId = payOrderPHRes.data.razorpayOrderId;
    const paymentIdPH = `pay_ph_${Date.now()}_seed_mismatched_pay_restaurantId`;
    const eventIdPH1 = `evt_ph1_${Date.now()}`;

    const whPayloadPH1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPH,
            order_id: rzpOrderPHId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPH1 = computeWebhookSignature(whPayloadPH1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPH1,
      'x-razorpay-event-id': eventIdPH1
    }, whPayloadPH1);
    await makeRequest('PATCH', `/api/orders/${orderPHId}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' }, { status: 'served', kitchenStatus: 'served', staffPin: '1234' });

    // Send second webhook for Order PH with new event ID -> reject with HTTP 400 because processedPayments restaurantId is mismatched
    const eventIdPH2 = `evt_ph2_${Date.now()}`;
    const whPayloadPH2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPH,
            order_id: rzpOrderPHId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPH2 = computeWebhookSignature(whPayloadPH2);
    const whResPHRetry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPH2,
      'x-razorpay-event-id': eventIdPH2
    }, whPayloadPH2);
    assert(whResPHRetry.statusCode === 400 || whResPHRetry.statusCode === 403, 'Test H (9i): Completed payment with mismatched restaurantId rejected');
    assert(whResPHRetry.data.error && (whResPHRetry.data.error.includes('Cross-tenant') || whResPHRetry.data.error.includes('belongs to restaurant')), 'Test H (9i): Error confirms cross-tenant payment rejection');

    const dbSnapPH = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapPH.processedWebhookEvents[eventIdPH2], 'Test H (9i): No event recorded for rejected request');

    // TEST I: Legitimate matching active-order retry still returns HTTP 200
    console.log('\n  [TEST I]: Legitimate matching active-order retry returns HTTP 200');
    const orderPIRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 70,
      tableName: 'Table 70',
      customerPhone: '9876543290',
      customerName: 'PI User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPIId = orderPIRes.data.id;
    const payOrderPIRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPIId });
    const rzpOrderPIId = payOrderPIRes.data.razorpayOrderId;
    const paymentIdPI = `pay_pi_${Date.now()}`;
    const eventIdPI1 = `evt_pi1_${Date.now()}`;

    const whPayloadPI1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPI,
            order_id: rzpOrderPIId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPI1 = computeWebhookSignature(whPayloadPI1);
    const whResPI1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPI1,
      'x-razorpay-event-id': eventIdPI1
    }, whPayloadPI1);
    assert(whResPI1.statusCode === 200, 'Test I (9i): Order PI initial settlement succeeded');

    // Replay with exact same event ID -> HTTP 200 idempotent
    const whResPIRetry1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPI1,
      'x-razorpay-event-id': eventIdPI1
    }, whPayloadPI1);
    assert(whResPIRetry1.statusCode === 200, 'Test I (9i): Exact same event ID retry returns HTTP 200');
    assert(whResPIRetry1.data.alreadyProcessed === true, 'Test I (9i): Response confirms alreadyProcessed: true');

    // Replay with new event ID for same payment and order -> HTTP 200 idempotent
    const eventIdPI2 = `evt_pi2_${Date.now()}`;
    const whPayloadPI2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPI,
            order_id: rzpOrderPIId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPI2 = computeWebhookSignature(whPayloadPI2);
    const whResPIRetry2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPI2,
      'x-razorpay-event-id': eventIdPI2
    }, whPayloadPI2);
    assert(whResPIRetry2.statusCode === 200, 'Test I (9i): New event ID retry on active order returns HTTP 200');
    assert(whResPIRetry2.data.alreadySettled === true, 'Test I (9i): Response confirms alreadySettled: true');

    // Verify customer spend and loyalty points remain strictly 294 and 29 (zero duplicate increment)
    const custPICheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custPI = (custPICheck.data.customers || []).find(c => c.phone === '9876543290');
    assert(custPI && custPI.totalSpent === 294, 'Test I (9i): Customer PI spend remains strictly 294 after retries');
    assert(custPI && custPI.loyaltyPoints === 29, 'Test I (9i): Customer PI loyalty points remain strictly 29 after retries');

    // TEST J: Legitimate matching completed-order retry still returns HTTP 200
    console.log('\n  [TEST J]: Legitimate matching completed-order retry returns HTTP 200');
    const orderPJRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 71,
      tableName: 'Table 71',
      customerPhone: '9876543291',
      customerName: 'PJ User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderPJId = orderPJRes.data.id;
    const payOrderPJRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderPJId });
    const rzpOrderPJId = payOrderPJRes.data.razorpayOrderId;
    const paymentIdPJ = `pay_pj_${Date.now()}`;
    const eventIdPJ1 = `evt_pj1_${Date.now()}`;

    const whPayloadPJ1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdPJ,
            order_id: rzpOrderPJId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPJ1 = computeWebhookSignature(whPayloadPJ1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPJ1,
      'x-razorpay-event-id': eventIdPJ1
    }, whPayloadPJ1);
    await makeRequest('PATCH', `/api/orders/${orderPJId}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' }, { status: 'served', kitchenStatus: 'served', staffPin: '1234' });

    // Retry with same event ID -> HTTP 200
    const whResPJRetry1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPJ1,
      'x-razorpay-event-id': eventIdPJ1
    }, whPayloadPJ1);
    assert(whResPJRetry1.statusCode === 200, 'Test J (9i): Completed order retry with same event ID returns HTTP 200');
    assert(whResPJRetry1.data.alreadyProcessed === true, 'Test J (9i): Response confirms alreadyProcessed: true');

    // Retry with new event ID -> HTTP 200
    const eventIdPJ2 = `evt_pj2_${Date.now()}`;
    const whPayloadPJ2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdPJ,
            order_id: rzpOrderPJId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigPJ2 = computeWebhookSignature(whPayloadPJ2);
    const whResPJRetry2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigPJ2,
      'x-razorpay-event-id': eventIdPJ2
    }, whPayloadPJ2);
    assert(whResPJRetry2.statusCode === 200, 'Test J (9i): Completed order retry with new event ID returns HTTP 200');
    assert(whResPJRetry2.data.alreadySettled === true, 'Test J (9i): Response confirms alreadySettled: true');

    // Verify customer spend and loyalty points remain strictly 294 and 29
    const custPJCheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custPJ = (custPJCheck.data.customers || []).find(c => c.phone === '9876543291');
    assert(custPJ && custPJ.totalSpent === 294, 'Test J (9i): Customer PJ spend remains strictly 294 after retries');
    assert(custPJ && custPJ.loyaltyPoints === 29, 'Test J (9i): Customer PJ loyalty points remain strictly 29 after retries');

    // ----------------------------------------------------
    // SECTION 9j: PROCESSED PAYMENT / ORDER STATE CONSISTENCY (TESTS A THROUGH J)
    // ----------------------------------------------------
    console.log('\n--- 9j. PROCESSED PAYMENT / ORDER STATE CONSISTENCY (TESTS A THROUGH J) ---');

    // TEST A: Existing processedPayments entry with correct ownership, but active order is unpaid -> HTTP 400
    console.log('\n  [TEST A]: Active order unpaid despite existing processed payment rejection');
    const orderJARes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 81,
      tableName: 'Table 81',
      customerPhone: '9876543301',
      customerName: 'JA User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJAId = orderJARes.data.id;
    const payOrderJARes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJAId });
    const rzpOrderJAId = payOrderJARes.data.razorpayOrderId;
    const paymentIdJA = `pay_ja_${Date.now()}_seed_active_unpaid`;
    const eventIdJA1 = `evt_ja1_${Date.now()}`;

    // Settle Order JA (seeded with isPaid: false on active order)
    const whPayloadJA1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJA,
            order_id: rzpOrderJAId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJA1 = computeWebhookSignature(whPayloadJA1);
    const whResJA1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJA1,
      'x-razorpay-event-id': eventIdJA1
    }, whPayloadJA1);
    assert(whResJA1.statusCode === 200, 'Test A (9j): Order JA initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 because active order is unpaid
    const eventIdJA2 = `evt_ja2_${Date.now()}`;
    const whPayloadJA2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJA,
            order_id: rzpOrderJAId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJA2 = computeWebhookSignature(whPayloadJA2);
    const whResJA2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJA2,
      'x-razorpay-event-id': eventIdJA2
    }, whPayloadJA2);
    assert(whResJA2.statusCode === 400, 'Test A (9j): Unpaid active order with processed payment rejected with HTTP 400');
    assert(whResJA2.data.error && whResJA2.data.error.includes('marked unpaid'), 'Test A (9j): Error confirms unpaid state rejected');

    // Verify zero side effects
    const dbSnapJA = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapJA.processedWebhookEvents[eventIdJA2], 'Test A (9j): No new webhook event record created for rejected request');
    const custJACheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custJA = (custJACheck.data.customers || []).find(c => c.phone === '9876543301');
    assert(custJA && custJA.totalSpent === 294, 'Test A (9j): Customer spend unchanged after rejection');
    assert(custJA && custJA.loyaltyPoints === 29, 'Test A (9j): Customer loyalty points unchanged after rejection');

    // TEST B: Existing processedPayments entry with correct ownership, but paymentStatus is pending -> HTTP 400
    console.log('\n  [TEST B]: Active order pending status despite existing processed payment rejection');
    const orderJBRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 82,
      tableName: 'Table 82',
      customerPhone: '9876543302',
      customerName: 'JB User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJBId = orderJBRes.data.id;
    const payOrderJBRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJBId });
    const rzpOrderJBId = payOrderJBRes.data.razorpayOrderId;
    const paymentIdJB = `pay_jb_${Date.now()}_seed_active_status_pending`;
    const eventIdJB1 = `evt_jb1_${Date.now()}`;

    // Settle Order JB (seeded with paymentStatus: 'pending')
    const whPayloadJB1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJB,
            order_id: rzpOrderJBId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJB1 = computeWebhookSignature(whPayloadJB1);
    const whResJB1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJB1,
      'x-razorpay-event-id': eventIdJB1
    }, whPayloadJB1);
    assert(whResJB1.statusCode === 200, 'Test B (9j): Order JB initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 because paymentStatus is pending
    const eventIdJB2 = `evt_jb2_${Date.now()}`;
    const whPayloadJB2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJB,
            order_id: rzpOrderJBId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJB2 = computeWebhookSignature(whPayloadJB2);
    const whResJB2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJB2,
      'x-razorpay-event-id': eventIdJB2
    }, whPayloadJB2);
    assert(whResJB2.statusCode === 400, 'Test B (9j): Pending paymentStatus on active order rejected with HTTP 400');
    assert(whResJB2.data.error && whResJB2.data.error.includes('paymentStatus is'), 'Test B (9j): Error confirms pending paymentStatus rejected');

    const dbSnapJB = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapJB.processedWebhookEvents[eventIdJB2], 'Test B (9j): No new webhook event record created for rejected request');
    const custJBCheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custJB = (custJBCheck.data.customers || []).find(c => c.phone === '9876543302');
    assert(custJB && custJB.totalSpent === 294, 'Test B (9j): Customer spend unchanged after rejection');

    // TEST C: Existing processedPayments entry with correct ownership, but txnId is missing -> HTTP 400
    console.log('\n  [TEST C]: Active order missing txnId despite existing processed payment rejection');
    const orderJCRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 83,
      tableName: 'Table 83',
      customerPhone: '9876543303',
      customerName: 'JC User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJCId = orderJCRes.data.id;
    const payOrderJCRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJCId });
    const rzpOrderJCId = payOrderJCRes.data.razorpayOrderId;
    const paymentIdJC = `pay_jc_${Date.now()}_seed_active_missing_txnId`;
    const eventIdJC1 = `evt_jc1_${Date.now()}`;

    // Settle Order JC (seeded with txnId: null on order)
    const whPayloadJC1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJC,
            order_id: rzpOrderJCId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJC1 = computeWebhookSignature(whPayloadJC1);
    const whResJC1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJC1,
      'x-razorpay-event-id': eventIdJC1
    }, whPayloadJC1);
    assert(whResJC1.statusCode === 200, 'Test C (9j): Order JC initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 because txnId is missing
    const eventIdJC2 = `evt_jc2_${Date.now()}`;
    const whPayloadJC2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJC,
            order_id: rzpOrderJCId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJC2 = computeWebhookSignature(whPayloadJC2);
    const whResJC2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJC2,
      'x-razorpay-event-id': eventIdJC2
    }, whPayloadJC2);
    assert(whResJC2.statusCode === 400, 'Test C (9j): Active order missing txnId rejected with HTTP 400');
    assert(whResJC2.data.error && whResJC2.data.error.includes('Missing persisted txnId'), 'Test C (9j): Error confirms missing txnId rejected');

    const dbSnapJC = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapJC.processedWebhookEvents[eventIdJC2], 'Test C (9j): No new webhook event record created for rejected request');

    // TEST D: Existing processedPayments entry with correct ownership, but paymentDetails.paymentId is missing -> HTTP 400
    console.log('\n  [TEST D]: Active order missing paymentDetails.paymentId rejection');
    const orderJDRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 84,
      tableName: 'Table 84',
      customerPhone: '9876543304',
      customerName: 'JD User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJDId = orderJDRes.data.id;
    const payOrderJDRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJDId });
    const rzpOrderJDId = payOrderJDRes.data.razorpayOrderId;
    const paymentIdJD = `pay_jd_${Date.now()}_seed_active_missing_payId`;
    const eventIdJD1 = `evt_jd1_${Date.now()}`;

    // Settle Order JD (seeded with deleted paymentDetails.paymentId)
    const whPayloadJD1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJD,
            order_id: rzpOrderJDId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJD1 = computeWebhookSignature(whPayloadJD1);
    const whResJD1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJD1,
      'x-razorpay-event-id': eventIdJD1
    }, whPayloadJD1);
    assert(whResJD1.statusCode === 200, 'Test D (9j): Order JD initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 because paymentDetails.paymentId is missing
    const eventIdJD2 = `evt_jd2_${Date.now()}`;
    const whPayloadJD2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJD,
            order_id: rzpOrderJDId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJD2 = computeWebhookSignature(whPayloadJD2);
    const whResJD2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJD2,
      'x-razorpay-event-id': eventIdJD2
    }, whPayloadJD2);
    assert(whResJD2.statusCode === 400, 'Test D (9j): Active order missing paymentDetails.paymentId rejected with HTTP 400');
    assert(whResJD2.data.error && whResJD2.data.error.includes('Missing persisted paymentDetails.paymentId'), 'Test D (9j): Error confirms missing paymentDetails.paymentId rejected');

    const dbSnapJD = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapJD.processedWebhookEvents[eventIdJD2], 'Test D (9j): No new webhook event record created for rejected request');

    // TEST E: Existing processedPayments entry with correct ownership, but paymentDetails.paymentId conflicts -> HTTP 400
    console.log('\n  [TEST E]: Active order conflicting paymentDetails.paymentId rejection');
    const orderJERes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 85,
      tableName: 'Table 85',
      customerPhone: '9876543305',
      customerName: 'JE User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJEId = orderJERes.data.id;
    const payOrderJERes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJEId });
    const rzpOrderJEId = payOrderJERes.data.razorpayOrderId;
    const paymentIdJE = `pay_je_${Date.now()}_seed_active_conflicting_payId`;
    const eventIdJE1 = `evt_je1_${Date.now()}`;

    // Settle Order JE (seeded with conflicting paymentDetails.paymentId)
    const whPayloadJE1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJE,
            order_id: rzpOrderJEId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJE1 = computeWebhookSignature(whPayloadJE1);
    const whResJE1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJE1,
      'x-razorpay-event-id': eventIdJE1
    }, whPayloadJE1);
    assert(whResJE1.statusCode === 200, 'Test E (9j): Order JE initial settlement succeeded');

    // Second webhook with new event ID -> reject with HTTP 400 due to conflicting payment identity
    const eventIdJE2 = `evt_je2_${Date.now()}`;
    const whPayloadJE2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJE,
            order_id: rzpOrderJEId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJE2 = computeWebhookSignature(whPayloadJE2);
    const whResJE2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJE2,
      'x-razorpay-event-id': eventIdJE2
    }, whPayloadJE2);
    assert(whResJE2.statusCode === 400, 'Test E (9j): Active order with conflicting paymentDetails.paymentId rejected with HTTP 400');
    assert(whResJE2.data.error && (whResJE2.data.error.includes('Inconsistent persisted payment identity') || whResJE2.data.error.includes('already settled with payment ID')), 'Test E (9j): Error confirms conflicting payment identity rejected');

    const dbSnapJE = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapJE.processedWebhookEvents[eventIdJE2], 'Test E (9j): No new webhook event record created for rejected request');

    // TEST F: Inconsistent state with a new webhook event ID must not create a processedWebhookEvents entry
    console.log('\n  [TEST F]: Verification that rejected inconsistent requests never create processedWebhookEvents entries');
    const dbSnap9jF = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnap9jF.processedWebhookEvents[eventIdJA2], 'Test F (9j): eventIdJA2 is absent from processedWebhookEvents');
    assert(!dbSnap9jF.processedWebhookEvents[eventIdJB2], 'Test F (9j): eventIdJB2 is absent from processedWebhookEvents');
    assert(!dbSnap9jF.processedWebhookEvents[eventIdJC2], 'Test F (9j): eventIdJC2 is absent from processedWebhookEvents');
    assert(!dbSnap9jF.processedWebhookEvents[eventIdJD2], 'Test F (9j): eventIdJD2 is absent from processedWebhookEvents');
    assert(!dbSnap9jF.processedWebhookEvents[eventIdJE2], 'Test F (9j): eventIdJE2 is absent from processedWebhookEvents');

    // TEST G: Inconsistent state must not change customer spend, loyalty, order state, or table state
    console.log('\n  [TEST G]: Verification that rejected inconsistent requests cause zero mutation to customer, order, or table state');
    // Pre-clean table 6 of any previous dining session
    const preStateG = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    for (const oldOrd of (preStateG.data.orders || []).filter(o => o.tableId === 6)) {
      await makeRequest('DELETE', `/api/orders/${oldOrd.id}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' });
    }

    const orderJGRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 6,
      tableName: 'Table 6',
      customerPhone: '9876543307',
      customerName: 'JG User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJGId = orderJGRes.data.id;
    const payOrderJGRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJGId });
    const rzpOrderJGId = payOrderJGRes.data.razorpayOrderId;
    const paymentIdJG = `pay_jg_${Date.now()}_seed_active_unpaid`;
    const eventIdJG1 = `evt_jg1_${Date.now()}`;

    // Settle Order JG initially (seeded unpaid)
    const whPayloadJG1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJG,
            order_id: rzpOrderJGId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJG1 = computeWebhookSignature(whPayloadJG1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJG1,
      'x-razorpay-event-id': eventIdJG1
    }, whPayloadJG1);

    // Snapshot state before rejected retry
    const stateBeforeRetryG = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custBeforeG = (stateBeforeRetryG.data.customers || []).find(c => c.phone === '9876543307');
    const tableBeforeG = (stateBeforeRetryG.data.tables || []).find(t => t.id === 6);
    const orderBeforeG = (stateBeforeRetryG.data.orders || []).find(o => o.id === orderJGId);

    // Attempt invalid retry with new event ID
    const eventIdJG2 = `evt_jg2_${Date.now()}`;
    const whPayloadJG2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJG,
            order_id: rzpOrderJGId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJG2 = computeWebhookSignature(whPayloadJG2);
    const whResJG2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJG2,
      'x-razorpay-event-id': eventIdJG2
    }, whPayloadJG2);
    assert(whResJG2.statusCode === 400, 'Test G (9j): Inconsistent retry rejected with HTTP 400');

    // Snapshot state after rejected retry
    const stateAfterRetryG = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterG = (stateAfterRetryG.data.customers || []).find(c => c.phone === '9876543307');
    const tableAfterG = (stateAfterRetryG.data.tables || []).find(t => t.id === 6);
    const orderAfterG = (stateAfterRetryG.data.orders || []).find(o => o.id === orderJGId);

    assert(custBeforeG.totalSpent === custAfterG.totalSpent, 'Test G (9j): Customer spend strictly unchanged after rejected retry');
    assert(custBeforeG.loyaltyPoints === custAfterG.loyaltyPoints, 'Test G (9j): Customer loyalty points strictly unchanged after rejected retry');
    assert(tableBeforeG.status === tableAfterG.status, 'Test G (9j): Table status strictly unchanged after rejected retry');
    assert(tableBeforeG.currentOrderId === tableAfterG.currentOrderId, 'Test G (9j): Table currentOrderId strictly unchanged after rejected retry');
    assert(orderBeforeG.isPaid === orderAfterG.isPaid, 'Test G (9j): Order isPaid state strictly unchanged after rejected retry');
    assert(orderBeforeG.paymentStatus === orderAfterG.paymentStatus, 'Test G (9j): Order paymentStatus strictly unchanged after rejected retry');

    // TEST H: Legitimate active-order retry remains HTTP 200
    console.log('\n  [TEST H]: Legitimate matching active-order retry returns HTTP 200');
    const orderJHRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 86,
      tableName: 'Table 86',
      customerPhone: '9876543308',
      customerName: 'JH User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJHId = orderJHRes.data.id;
    const payOrderJHRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJHId });
    const rzpOrderJHId = payOrderJHRes.data.razorpayOrderId;
    const paymentIdJH = `pay_jh_${Date.now()}`;
    const eventIdJH1 = `evt_jh1_${Date.now()}`;

    const whPayloadJH1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJH,
            order_id: rzpOrderJHId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJH1 = computeWebhookSignature(whPayloadJH1);
    const whResJH1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJH1,
      'x-razorpay-event-id': eventIdJH1
    }, whPayloadJH1);
    assert(whResJH1.statusCode === 200, 'Test H (9j): Order JH initial settlement succeeded');

    // Replay with exact same event ID -> HTTP 200 idempotent
    const whResJHRetry1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJH1,
      'x-razorpay-event-id': eventIdJH1
    }, whPayloadJH1);
    assert(whResJHRetry1.statusCode === 200, 'Test H (9j): Exact same event ID retry returns HTTP 200');
    assert(whResJHRetry1.data.alreadyProcessed === true, 'Test H (9j): Response confirms alreadyProcessed: true');

    // Replay with new event ID for same payment and order -> HTTP 200 idempotent
    const eventIdJH2 = `evt_jh2_${Date.now()}`;
    const whPayloadJH2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJH,
            order_id: rzpOrderJHId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJH2 = computeWebhookSignature(whPayloadJH2);
    const whResJHRetry2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJH2,
      'x-razorpay-event-id': eventIdJH2
    }, whPayloadJH2);
    assert(whResJHRetry2.statusCode === 200, 'Test H (9j): New event ID retry on active order returns HTTP 200');
    assert(whResJHRetry2.data.alreadySettled === true, 'Test H (9j): Response confirms alreadySettled: true');

    // Verify new event ID recorded in persistent storage
    const dbSnapJH = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(dbSnapJH.processedWebhookEvents[eventIdJH2], 'Test H (9j): New event ID atomically persisted for legitimate active-order retry');
    const custJHCheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custJH = (custJHCheck.data.customers || []).find(c => c.phone === '9876543308');
    assert(custJH && custJH.totalSpent === 294, 'Test H (9j): Customer JH spend strictly 294 after retries');
    assert(custJH && custJH.loyaltyPoints === 29, 'Test H (9j): Customer JH loyalty points strictly 29 after retries');

    // TEST I: Legitimate completed-order retry remains HTTP 200
    console.log('\n  [TEST I]: Legitimate matching completed-order retry returns HTTP 200');
    const orderJIRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 87,
      tableName: 'Table 87',
      customerPhone: '9876543309',
      customerName: 'JI User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJIId = orderJIRes.data.id;
    const payOrderJIRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJIId });
    const rzpOrderJIId = payOrderJIRes.data.razorpayOrderId;
    const paymentIdJI = `pay_ji_${Date.now()}`;
    const eventIdJI1 = `evt_ji1_${Date.now()}`;

    const whPayloadJI1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdJI,
            order_id: rzpOrderJIId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJI1 = computeWebhookSignature(whPayloadJI1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJI1,
      'x-razorpay-event-id': eventIdJI1
    }, whPayloadJI1);
    await makeRequest('PATCH', `/api/orders/${orderJIId}?restaurant=tiptap-bistro`, { 'x-staff-pin': '1234' }, { status: 'served', kitchenStatus: 'served', staffPin: '1234' });

    // Retry with same event ID -> HTTP 200
    const whResJIRetry1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJI1,
      'x-razorpay-event-id': eventIdJI1
    }, whPayloadJI1);
    assert(whResJIRetry1.statusCode === 200, 'Test I (9j): Completed order retry with same event ID returns HTTP 200');
    assert(whResJIRetry1.data.alreadyProcessed === true, 'Test I (9j): Response confirms alreadyProcessed: true');

    // Retry with new event ID -> HTTP 200
    const eventIdJI2 = `evt_ji2_${Date.now()}`;
    const whPayloadJI2 = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJI,
            order_id: rzpOrderJIId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJI2 = computeWebhookSignature(whPayloadJI2);
    const whResJIRetry2 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJI2,
      'x-razorpay-event-id': eventIdJI2
    }, whPayloadJI2);
    assert(whResJIRetry2.statusCode === 200, 'Test I (9j): Completed order retry with new event ID returns HTTP 200');
    assert(whResJIRetry2.data.alreadySettled === true, 'Test I (9j): Response confirms alreadySettled: true');

    const custJICheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custJI = (custJICheck.data.customers || []).find(c => c.phone === '9876543309');
    assert(custJI && custJI.totalSpent === 294, 'Test I (9j): Customer JI spend remains strictly 294 after retries');
    assert(custJI && custJI.loyaltyPoints === 29, 'Test I (9j): Customer JI loyalty points remain strictly 29 after retries');

    // TEST J: Existing cross-order and cross-tenant rejection tests continue passing
    console.log('\n  [TEST J]: Cross-order and cross-tenant rejection tests verification');
    // Attempt to settle a new active order JK2 using paymentIdJH (which already belongs to order JH)
    const orderJK2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 88,
      tableName: 'Table 88',
      customerPhone: '9876543310',
      customerName: 'JK2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const orderJK2Id = orderJK2Res.data.id;
    const payOrderJK2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderJK2Id });
    const rzpOrderJK2Id = payOrderJK2Res.data.razorpayOrderId;

    const eventIdJKClash = `evt_jk_clash_${Date.now()}`;
    const whPayloadJKClash = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentIdJH, // Belongs to order JH
            order_id: rzpOrderJK2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigJKClash = computeWebhookSignature(whPayloadJKClash);
    const whResJKClash = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigJKClash,
      'x-razorpay-event-id': eventIdJKClash
    }, whPayloadJKClash);
    assert(whResJKClash.statusCode === 400, 'Test J (9j): Reusing payment on different active order rejected with HTTP 400');
    assert(whResJKClash.data.error && (whResJKClash.data.error.includes('already consumed by order') || whResJKClash.data.error.includes('already settled with payment ID')), 'Test J (9j): Error confirms cross-order rejection');

    const dbSnapJK = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(!dbSnapJK.processedWebhookEvents[eventIdJKClash], 'Test J (9j): No event ID recorded for cross-order rejection');

    // ----------------------------------------------------
    // SECTION 9k: SAME EVENT-ID REPLAY PAYMENT CONSISTENCY (TESTS K THROUGH O)
    // ----------------------------------------------------
    console.log('\n--- 9k. SAME EVENT-ID REPLAY PAYMENT CONSISTENCY (TESTS K THROUGH O) ---');

    // TEST K: Existing event ID, order later becomes unpaid -> HTTP 400
    console.log('\n  [TEST K]: Replay with same event ID when order becomes unpaid rejection');
    const order9kKRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 91,
      tableName: 'Table 91',
      customerPhone: '9876543401',
      customerName: 'K User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kKId = order9kKRes.data.id;
    const payOrder9kKRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kKId });
    const rzpOrder9kKId = payOrder9kKRes.data.razorpayOrderId;
    const paymentId9kK = `pay_9kk_${Date.now()}`;
    const eventId9kK = `evt_9kk_${Date.now()}`;

    // Settle Order K initially (normal settlement)
    const whPayload9kK = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kK,
            order_id: rzpOrder9kKId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kK = computeWebhookSignature(whPayload9kK);
    const whRes9kK1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kK,
      'x-razorpay-event-id': eventId9kK
    }, whPayload9kK);
    assert(whRes9kK1.statusCode === 200, 'Test K (9k): Order K initial settlement succeeded');

    // Confirm payment and event records exist
    const dbSnap9kK1 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    assert(dbSnap9kK1.processedPayments[paymentId9kK], 'Test K (9k): processedPayments entry exists');
    assert(dbSnap9kK1.processedWebhookEvents[eventId9kK], 'Test K (9k): processedWebhookEvents entry exists');
    const cust9kK1Check = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const cust9kK1 = (cust9kK1Check.data.customers || []).find(c => c.phone === '9876543401');
    assert(cust9kK1 && cust9kK1.totalSpent === 294, 'Test K (9k): Customer initial spend is 294');

    // Change order state to isPaid: false via authorized counter PATCH (deliberate test corruption)
    const patch9kKRes = await makeRequest('PATCH', `/api/orders/${order9kKId}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234',
      'x-test-corrupt-state': 'true'
    }, {
      isPaid: false,
      staffPin: '1234',
      testCorruptState: true
    });
    assert(patch9kKRes.statusCode === 200, 'Test K (9k): Order isPaid set to false via authorized PATCH');

    // Capture SNAPSHOT BEFORE rejected replay
    const dbSnapBeforeK = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBeforeK = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const payRecordBeforeK = JSON.stringify(dbSnapBeforeK.processedPayments[paymentId9kK]);
    const evtRecordBeforeK = JSON.stringify(dbSnapBeforeK.processedWebhookEvents[eventId9kK]);
    const custBeforeK = (stateBeforeK.data.customers || []).find(c => c.phone === '9876543401');
    const tableBeforeK = (stateBeforeK.data.tables || []).find(t => t.id === 91);
    const orderBeforeK = (stateBeforeK.data.orders || []).find(o => o.id === order9kKId);
    assert(tableBeforeK && tableBeforeK.status === 'occupied', 'Test K (9k): Table 91 status is occupied before replay');
    assert(tableBeforeK && tableBeforeK.currentOrderId === order9kKId, 'Test K (9k): Table 91 currentOrderId bound to order9kKId before replay');

    // Replay the exact same event ID and payment ID -> must fail closed with HTTP 400
    const whRes9kKRetry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kK,
      'x-razorpay-event-id': eventId9kK
    }, whPayload9kK);
    assert(whRes9kKRetry.statusCode === 400, 'Test K (9k): Same event ID replay on unpaid order rejected with HTTP 400');
    assert(whRes9kKRetry.data.error && whRes9kKRetry.data.error.includes('marked unpaid'), 'Test K (9k): Error confirms unpaid state rejected');

    // Capture SNAPSHOT AFTER rejected replay & verify zero side effects
    const dbSnapAfterK = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateAfterK = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterK = (stateAfterK.data.customers || []).find(c => c.phone === '9876543401');
    const tableAfterK = (stateAfterK.data.tables || []).find(t => t.id === 91);
    const orderAfterK = (stateAfterK.data.orders || []).find(o => o.id === order9kKId);

    assert(JSON.stringify(dbSnapAfterK.processedPayments[paymentId9kK]) === payRecordBeforeK, 'Test K (9k): processedPayments record unchanged');
    assert(JSON.stringify(dbSnapAfterK.processedWebhookEvents[eventId9kK]) === evtRecordBeforeK, 'Test K (9k): processedWebhookEvents record unchanged');
    assert(custAfterK && custAfterK.totalSpent === custBeforeK.totalSpent, 'Test K (9k): Customer totalSpent unchanged');
    assert(custAfterK && custAfterK.loyaltyPoints === custBeforeK.loyaltyPoints, 'Test K (9k): Customer loyaltyPoints unchanged');
    assert(tableAfterK && tableAfterK.status === tableBeforeK.status, 'Test K (9k): Table status unchanged');
    assert(tableAfterK && tableAfterK.currentOrderId === tableBeforeK.currentOrderId, 'Test K (9k): Table currentOrderId unchanged');
    assert(orderAfterK && orderAfterK.isPaid === false, 'Test K (9k): Order payment identity isPaid remains false (deliberate test corruption)');
    assert(orderAfterK && orderAfterK.paymentStatus === orderBeforeK.paymentStatus, 'Test K (9k): Order paymentStatus unchanged');
    assert(orderAfterK && orderAfterK.txnId === orderBeforeK.txnId, 'Test K (9k): Order txnId unchanged');
    assert(orderAfterK && JSON.stringify(orderAfterK.paymentDetails) === JSON.stringify(orderBeforeK.paymentDetails), 'Test K (9k): Order paymentDetails unchanged');

    // TEST L: Existing event ID, paymentStatus becomes pending -> HTTP 400
    console.log('\n  [TEST L]: Replay with same event ID when paymentStatus is pending rejection');
    const order9kLRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 92,
      tableName: 'Table 92',
      customerPhone: '9876543402',
      customerName: 'L User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kLId = order9kLRes.data.id;
    const payOrder9kLRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kLId });
    const rzpOrder9kLId = payOrder9kLRes.data.razorpayOrderId;
    const paymentId9kL = `pay_9kl_${Date.now()}`;
    const eventId9kL = `evt_9kl_${Date.now()}`;

    const whPayload9kL = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kL,
            order_id: rzpOrder9kLId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kL = computeWebhookSignature(whPayload9kL);
    const whRes9kL1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kL,
      'x-razorpay-event-id': eventId9kL
    }, whPayload9kL);
    assert(whRes9kL1.statusCode === 200, 'Test L (9k): Order L initial settlement succeeded');

    // Change paymentStatus to 'pending' via authorized PATCH (deliberate test corruption)
    const patch9kLRes = await makeRequest('PATCH', `/api/orders/${order9kLId}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234',
      'x-test-corrupt-state': 'true'
    }, {
      paymentStatus: 'pending',
      staffPin: '1234',
      testCorruptState: true
    });
    assert(patch9kLRes.statusCode === 200, 'Test L (9k): Order paymentStatus set to pending');

    // Capture SNAPSHOT BEFORE rejected replay
    const dbSnapBeforeL = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBeforeL = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const payRecordBeforeL = JSON.stringify(dbSnapBeforeL.processedPayments[paymentId9kL]);
    const evtRecordBeforeL = JSON.stringify(dbSnapBeforeL.processedWebhookEvents[eventId9kL]);
    const custBeforeL = (stateBeforeL.data.customers || []).find(c => c.phone === '9876543402');
    const tableBeforeL = (stateBeforeL.data.tables || []).find(t => t.id === 92);
    const orderBeforeL = (stateBeforeL.data.orders || []).find(o => o.id === order9kLId);
    assert(tableBeforeL && tableBeforeL.status === 'occupied', 'Test L (9k): Table 92 status is occupied before replay');
    assert(tableBeforeL && tableBeforeL.currentOrderId === order9kLId, 'Test L (9k): Table 92 currentOrderId bound to order9kLId before replay');

    // Replay exact same event ID -> HTTP 400
    const whRes9kLRetry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kL,
      'x-razorpay-event-id': eventId9kL
    }, whPayload9kL);
    assert(whRes9kLRetry.statusCode === 400, 'Test L (9k): Same event ID replay with pending paymentStatus rejected with HTTP 400');
    assert(whRes9kLRetry.data.error && whRes9kLRetry.data.error.includes('paymentStatus is'), 'Test L (9k): Error confirms pending paymentStatus rejected');

    // Capture SNAPSHOT AFTER rejected replay & verify zero side effects
    const dbSnapAfterL = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateAfterL = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterL = (stateAfterL.data.customers || []).find(c => c.phone === '9876543402');
    const tableAfterL = (stateAfterL.data.tables || []).find(t => t.id === 92);
    const orderAfterL = (stateAfterL.data.orders || []).find(o => o.id === order9kLId);

    assert(JSON.stringify(dbSnapAfterL.processedPayments[paymentId9kL]) === payRecordBeforeL, 'Test L (9k): processedPayments record unchanged');
    assert(JSON.stringify(dbSnapAfterL.processedWebhookEvents[eventId9kL]) === evtRecordBeforeL, 'Test L (9k): processedWebhookEvents record unchanged');
    assert(custAfterL && custAfterL.totalSpent === custBeforeL.totalSpent, 'Test L (9k): Customer totalSpent unchanged');
    assert(custAfterL && custAfterL.loyaltyPoints === custBeforeL.loyaltyPoints, 'Test L (9k): Customer loyaltyPoints unchanged');
    assert(tableAfterL && tableAfterL.status === tableBeforeL.status, 'Test L (9k): Table status unchanged');
    assert(tableAfterL && tableAfterL.currentOrderId === tableBeforeL.currentOrderId, 'Test L (9k): Table currentOrderId unchanged');
    assert(orderAfterL && orderAfterL.paymentStatus === 'pending', 'Test L (9k): Order paymentStatus remains pending (deliberate test corruption)');
    assert(orderAfterL && orderAfterL.isPaid === orderBeforeL.isPaid, 'Test L (9k): Order isPaid unchanged');
    assert(orderAfterL && orderAfterL.txnId === orderBeforeL.txnId, 'Test L (9k): Order txnId unchanged');
    assert(orderAfterL && JSON.stringify(orderAfterL.paymentDetails) === JSON.stringify(orderBeforeL.paymentDetails), 'Test L (9k): Order paymentDetails unchanged');

    // TEST M: Existing event ID, txnId or paymentDetails.paymentId becomes inconsistent -> HTTP 400
    console.log('\n  [TEST M]: Replay with same event ID with inconsistent txnId or paymentDetails rejection');
    // M1: Missing txnId
    const order9kM1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 93,
      tableName: 'Table 93',
      customerPhone: '9876543403',
      customerName: 'M1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kM1Id = order9kM1Res.data.id;
    const payOrder9kM1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kM1Id });
    const rzpOrder9kM1Id = payOrder9kM1Res.data.razorpayOrderId;
    const paymentId9kM1 = `pay_9km1_${Date.now()}`;
    const eventId9kM1 = `evt_9km1_${Date.now()}`;

    const whPayload9kM1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kM1,
            order_id: rzpOrder9kM1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kM1 = computeWebhookSignature(whPayload9kM1);
    const whRes9kM1Init = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kM1,
      'x-razorpay-event-id': eventId9kM1
    }, whPayload9kM1);
    assert(whRes9kM1Init.statusCode === 200, 'Test M1 (9k): Order M1 initial settlement succeeded');

    // Set txnId to null (deliberate test corruption)
    const patch9kM1Res = await makeRequest('PATCH', `/api/orders/${order9kM1Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234',
      'x-test-corrupt-state': 'true'
    }, {
      txnId: null,
      staffPin: '1234',
      testCorruptState: true
    });
    assert(patch9kM1Res.statusCode === 200, 'Test M1 (9k): Order txnId set to null via authorized PATCH');

    // Capture SNAPSHOT BEFORE rejected replay
    const dbSnapBeforeM1 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBeforeM1 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const payRecordBeforeM1 = JSON.stringify(dbSnapBeforeM1.processedPayments[paymentId9kM1]);
    const evtRecordBeforeM1 = JSON.stringify(dbSnapBeforeM1.processedWebhookEvents[eventId9kM1]);
    const custBeforeM1 = (stateBeforeM1.data.customers || []).find(c => c.phone === '9876543403');
    const tableBeforeM1 = (stateBeforeM1.data.tables || []).find(t => t.id === 93);
    const orderBeforeM1 = (stateBeforeM1.data.orders || []).find(o => o.id === order9kM1Id);
    assert(tableBeforeM1 && tableBeforeM1.status === 'occupied', 'Test M1 (9k): Table 93 status is occupied before replay');
    assert(tableBeforeM1 && tableBeforeM1.currentOrderId === order9kM1Id, 'Test M1 (9k): Table 93 currentOrderId bound to order9kM1Id before replay');

    // Replay exact same event ID -> HTTP 400
    const whRes9kM1Retry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kM1,
      'x-razorpay-event-id': eventId9kM1
    }, whPayload9kM1);
    assert(whRes9kM1Retry.statusCode === 400, 'Test M1 (9k): Same event ID replay with missing txnId rejected with HTTP 400');
    assert(whRes9kM1Retry.data.error && whRes9kM1Retry.data.error.includes('Missing persisted txnId'), 'Test M1 (9k): Error confirms missing txnId rejected');

    // Capture SNAPSHOT AFTER rejected replay & verify zero side effects
    const dbSnapAfterM1 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateAfterM1 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterM1 = (stateAfterM1.data.customers || []).find(c => c.phone === '9876543403');
    const tableAfterM1 = (stateAfterM1.data.tables || []).find(t => t.id === 93);
    const orderAfterM1 = (stateAfterM1.data.orders || []).find(o => o.id === order9kM1Id);

    assert(JSON.stringify(dbSnapAfterM1.processedPayments[paymentId9kM1]) === payRecordBeforeM1, 'Test M1 (9k): processedPayments record unchanged');
    assert(JSON.stringify(dbSnapAfterM1.processedWebhookEvents[eventId9kM1]) === evtRecordBeforeM1, 'Test M1 (9k): processedWebhookEvents record unchanged');
    assert(custAfterM1 && custAfterM1.totalSpent === custBeforeM1.totalSpent, 'Test M1 (9k): Customer totalSpent unchanged');
    assert(custAfterM1 && custAfterM1.loyaltyPoints === custBeforeM1.loyaltyPoints, 'Test M1 (9k): Customer loyaltyPoints unchanged');
    assert(tableAfterM1 && tableAfterM1.status === tableBeforeM1.status, 'Test M1 (9k): Table status unchanged');
    assert(tableAfterM1 && tableAfterM1.currentOrderId === tableBeforeM1.currentOrderId, 'Test M1 (9k): Table currentOrderId unchanged');
    assert(orderAfterM1 && !orderAfterM1.txnId, 'Test M1 (9k): Order txnId remains null (deliberate test corruption)');
    assert(orderAfterM1 && orderAfterM1.isPaid === orderBeforeM1.isPaid, 'Test M1 (9k): Order isPaid unchanged');
    assert(orderAfterM1 && orderAfterM1.paymentStatus === orderBeforeM1.paymentStatus, 'Test M1 (9k): Order paymentStatus unchanged');
    assert(orderAfterM1 && JSON.stringify(orderAfterM1.paymentDetails) === JSON.stringify(orderBeforeM1.paymentDetails), 'Test M1 (9k): Order paymentDetails unchanged');

    // M2: Missing paymentDetails.paymentId
    const order9kM2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 94,
      tableName: 'Table 94',
      customerPhone: '9876543404',
      customerName: 'M2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kM2Id = order9kM2Res.data.id;
    const payOrder9kM2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kM2Id });
    const rzpOrder9kM2Id = payOrder9kM2Res.data.razorpayOrderId;
    const paymentId9kM2 = `pay_9km2_${Date.now()}`;
    const eventId9kM2 = `evt_9km2_${Date.now()}`;

    const whPayload9kM2 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kM2,
            order_id: rzpOrder9kM2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kM2 = computeWebhookSignature(whPayload9kM2);
    const whRes9kM2Init = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kM2,
      'x-razorpay-event-id': eventId9kM2
    }, whPayload9kM2);
    assert(whRes9kM2Init.statusCode === 200, 'Test M2 (9k): Order M2 initial settlement succeeded');

    // Set paymentDetails without paymentId (deliberate test corruption)
    const patch9kM2Res = await makeRequest('PATCH', `/api/orders/${order9kM2Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234',
      'x-test-corrupt-state': 'true'
    }, {
      paymentDetails: { provider: 'test', txnId: paymentId9kM2 },
      staffPin: '1234',
      testCorruptState: true
    });
    assert(patch9kM2Res.statusCode === 200, 'Test M2 (9k): Order paymentDetails updated without paymentId via authorized PATCH');

    // Capture SNAPSHOT BEFORE rejected replay
    const dbSnapBeforeM2 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBeforeM2 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const payRecordBeforeM2 = JSON.stringify(dbSnapBeforeM2.processedPayments[paymentId9kM2]);
    const evtRecordBeforeM2 = JSON.stringify(dbSnapBeforeM2.processedWebhookEvents[eventId9kM2]);
    const custBeforeM2 = (stateBeforeM2.data.customers || []).find(c => c.phone === '9876543404');
    const tableBeforeM2 = (stateBeforeM2.data.tables || []).find(t => t.id === 94);
    const orderBeforeM2 = (stateBeforeM2.data.orders || []).find(o => o.id === order9kM2Id);
    assert(tableBeforeM2 && tableBeforeM2.status === 'occupied', 'Test M2 (9k): Table 94 status is occupied before replay');
    assert(tableBeforeM2 && tableBeforeM2.currentOrderId === order9kM2Id, 'Test M2 (9k): Table 94 currentOrderId bound to order9kM2Id before replay');

    // Replay exact same event ID -> HTTP 400
    const whRes9kM2Retry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kM2,
      'x-razorpay-event-id': eventId9kM2
    }, whPayload9kM2);
    assert(whRes9kM2Retry.statusCode === 400, 'Test M2 (9k): Same event ID replay with missing paymentDetails.paymentId rejected with HTTP 400');
    assert(whRes9kM2Retry.data.error && whRes9kM2Retry.data.error.includes('Missing persisted paymentDetails.paymentId'), 'Test M2 (9k): Error confirms missing paymentDetails.paymentId rejected');

    // Capture SNAPSHOT AFTER rejected replay & verify zero side effects
    const dbSnapAfterM2 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateAfterM2 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterM2 = (stateAfterM2.data.customers || []).find(c => c.phone === '9876543404');
    const tableAfterM2 = (stateAfterM2.data.tables || []).find(t => t.id === 94);
    const orderAfterM2 = (stateAfterM2.data.orders || []).find(o => o.id === order9kM2Id);

    assert(JSON.stringify(dbSnapAfterM2.processedPayments[paymentId9kM2]) === payRecordBeforeM2, 'Test M2 (9k): processedPayments record unchanged');
    assert(JSON.stringify(dbSnapAfterM2.processedWebhookEvents[eventId9kM2]) === evtRecordBeforeM2, 'Test M2 (9k): processedWebhookEvents record unchanged');
    assert(custAfterM2 && custAfterM2.totalSpent === custBeforeM2.totalSpent, 'Test M2 (9k): Customer totalSpent unchanged');
    assert(custAfterM2 && custAfterM2.loyaltyPoints === custBeforeM2.loyaltyPoints, 'Test M2 (9k): Customer loyaltyPoints unchanged');
    assert(tableAfterM2 && tableAfterM2.status === tableBeforeM2.status, 'Test M2 (9k): Table status unchanged');
    assert(tableAfterM2 && tableAfterM2.currentOrderId === tableBeforeM2.currentOrderId, 'Test M2 (9k): Table currentOrderId unchanged');
    assert(orderAfterM2 && (!orderAfterM2.paymentDetails || !orderAfterM2.paymentDetails.paymentId), 'Test M2 (9k): Order paymentDetails.paymentId remains missing (deliberate test corruption)');
    assert(orderAfterM2 && orderAfterM2.isPaid === orderBeforeM2.isPaid, 'Test M2 (9k): Order isPaid unchanged');
    assert(orderAfterM2 && orderAfterM2.paymentStatus === orderBeforeM2.paymentStatus, 'Test M2 (9k): Order paymentStatus unchanged');
    assert(orderAfterM2 && orderAfterM2.txnId === orderBeforeM2.txnId, 'Test M2 (9k): Order txnId unchanged');

    // M3: Conflicting paymentDetails.paymentId
    const order9kM3Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 95,
      tableName: 'Table 95',
      customerPhone: '9876543405',
      customerName: 'M3 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kM3Id = order9kM3Res.data.id;
    const payOrder9kM3Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kM3Id });
    const rzpOrder9kM3Id = payOrder9kM3Res.data.razorpayOrderId;
    const paymentId9kM3 = `pay_9km3_${Date.now()}`;
    const eventId9kM3 = `evt_9km3_${Date.now()}`;

    const whPayload9kM3 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kM3,
            order_id: rzpOrder9kM3Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kM3 = computeWebhookSignature(whPayload9kM3);
    const whRes9kM3Init = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kM3,
      'x-razorpay-event-id': eventId9kM3
    }, whPayload9kM3);
    assert(whRes9kM3Init.statusCode === 200, 'Test M3 (9k): Order M3 initial settlement succeeded');

    // Set conflicting paymentDetails.paymentId (deliberate test corruption)
    const patch9kM3Res = await makeRequest('PATCH', `/api/orders/${order9kM3Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234',
      'x-test-corrupt-state': 'true'
    }, {
      paymentDetails: { provider: 'test', paymentId: `pay_conflict_${Date.now()}`, txnId: paymentId9kM3 },
      staffPin: '1234',
      testCorruptState: true
    });
    assert(patch9kM3Res.statusCode === 200, 'Test M3 (9k): Order paymentDetails updated with conflicting paymentId via authorized PATCH');

    // Capture SNAPSHOT BEFORE rejected replay
    const dbSnapBeforeM3 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBeforeM3 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const payRecordBeforeM3 = JSON.stringify(dbSnapBeforeM3.processedPayments[paymentId9kM3]);
    const evtRecordBeforeM3 = JSON.stringify(dbSnapBeforeM3.processedWebhookEvents[eventId9kM3]);
    const custBeforeM3 = (stateBeforeM3.data.customers || []).find(c => c.phone === '9876543405');
    const tableBeforeM3 = (stateBeforeM3.data.tables || []).find(t => t.id === 95);
    const orderBeforeM3 = (stateBeforeM3.data.orders || []).find(o => o.id === order9kM3Id);
    assert(tableBeforeM3 && tableBeforeM3.status === 'occupied', 'Test M3 (9k): Table 95 status is occupied before replay');
    assert(tableBeforeM3 && tableBeforeM3.currentOrderId === order9kM3Id, 'Test M3 (9k): Table 95 currentOrderId bound to order9kM3Id before replay');

    // Replay exact same event ID -> HTTP 400
    const whRes9kM3Retry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kM3,
      'x-razorpay-event-id': eventId9kM3
    }, whPayload9kM3);
    assert(whRes9kM3Retry.statusCode === 400, 'Test M3 (9k): Same event ID replay with conflicting paymentDetails.paymentId rejected with HTTP 400');
    assert(whRes9kM3Retry.data.error && (whRes9kM3Retry.data.error.includes('Inconsistent persisted payment identity') || whRes9kM3Retry.data.error.includes('already settled with payment ID')), 'Test M3 (9k): Error confirms conflicting payment identity rejected');

    // Capture SNAPSHOT AFTER rejected replay & verify zero side effects
    const dbSnapAfterM3 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateAfterM3 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const custAfterM3 = (stateAfterM3.data.customers || []).find(c => c.phone === '9876543405');
    const tableAfterM3 = (stateAfterM3.data.tables || []).find(t => t.id === 95);
    const orderAfterM3 = (stateAfterM3.data.orders || []).find(o => o.id === order9kM3Id);

    assert(JSON.stringify(dbSnapAfterM3.processedPayments[paymentId9kM3]) === payRecordBeforeM3, 'Test M3 (9k): processedPayments record unchanged');
    assert(JSON.stringify(dbSnapAfterM3.processedWebhookEvents[eventId9kM3]) === evtRecordBeforeM3, 'Test M3 (9k): processedWebhookEvents record unchanged');
    assert(custAfterM3 && custAfterM3.totalSpent === custBeforeM3.totalSpent, 'Test M3 (9k): Customer totalSpent unchanged');
    assert(custAfterM3 && custAfterM3.loyaltyPoints === custBeforeM3.loyaltyPoints, 'Test M3 (9k): Customer loyaltyPoints unchanged');
    assert(tableAfterM3 && tableAfterM3.status === tableBeforeM3.status, 'Test M3 (9k): Table status unchanged');
    assert(tableAfterM3 && tableAfterM3.currentOrderId === tableBeforeM3.currentOrderId, 'Test M3 (9k): Table currentOrderId unchanged');
    assert(orderAfterM3 && orderAfterM3.paymentDetails.paymentId === orderBeforeM3.paymentDetails.paymentId, 'Test M3 (9k): Order paymentDetails.paymentId remains conflicting (deliberate test corruption)');
    assert(orderAfterM3 && orderAfterM3.isPaid === orderBeforeM3.isPaid, 'Test M3 (9k): Order isPaid unchanged');
    assert(orderAfterM3 && orderAfterM3.paymentStatus === orderBeforeM3.paymentStatus, 'Test M3 (9k): Order paymentStatus unchanged');
    assert(orderAfterM3 && orderAfterM3.txnId === orderBeforeM3.txnId, 'Test M3 (9k): Order txnId unchanged');

    // TEST N: Legitimate same-event retry remains HTTP 200
    console.log('\n  [TEST N]: Legitimate matching same-event retry returns HTTP 200');
    const order9kNRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 96,
      tableName: 'Table 96',
      customerPhone: '9876543406',
      customerName: 'N User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kNId = order9kNRes.data.id;
    const payOrder9kNRes = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kNId });
    const rzpOrder9kNId = payOrder9kNRes.data.razorpayOrderId;
    const paymentId9kN = `pay_9kn_${Date.now()}`;
    const eventId9kN = `evt_9kn_${Date.now()}`;

    const whPayload9kN = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kN,
            order_id: rzpOrder9kNId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kN = computeWebhookSignature(whPayload9kN);
    const whRes9kN1 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kN,
      'x-razorpay-event-id': eventId9kN
    }, whPayload9kN);
    assert(whRes9kN1.statusCode === 200, 'Test N (9k): Order N initial settlement succeeded');

    // Replay with exact same event ID -> HTTP 200
    const whRes9kNRetry = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kN,
      'x-razorpay-event-id': eventId9kN
    }, whPayload9kN);
    assert(whRes9kNRetry.statusCode === 200, 'Test N (9k): Same event ID retry returns HTTP 200');
    assert(whRes9kNRetry.data.alreadyProcessed === true, 'Test N (9k): Response confirms alreadyProcessed: true');
    assert(whRes9kNRetry.data.alreadySettled === true, 'Test N (9k): Response confirms alreadySettled: true');

    const cust9kNCheck = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const cust9kN = (cust9kNCheck.data.customers || []).find(c => c.phone === '9876543406');
    assert(cust9kN && cust9kN.totalSpent === 294, 'Test N (9k): Customer N spend remains strictly 294 after same-event retry');
    assert(cust9kN && cust9kN.loyaltyPoints === 29, 'Test N (9k): Customer N loyalty points remain strictly 29 after same-event retry');

    // TEST O: Cross-order and cross-tenant regressions with same event ID
    console.log('\n  [TEST O]: Cross-order and cross-tenant same event ID regressions');
    // Order O1 (settled)
    const order9kO1Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 97,
      tableName: 'Table 97',
      customerPhone: '9876543407',
      customerName: 'O1 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kO1Id = order9kO1Res.data.id;
    const payOrder9kO1Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kO1Id });
    const rzpOrder9kO1Id = payOrder9kO1Res.data.razorpayOrderId;
    const paymentId9kO1 = `pay_9ko1_${Date.now()}`;
    const eventId9kO1 = `evt_9ko1_${Date.now()}`;

    const whPayload9kO1 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId9kO1,
            order_id: rzpOrder9kO1Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kO1 = computeWebhookSignature(whPayload9kO1);
    await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kO1,
      'x-razorpay-event-id': eventId9kO1
    }, whPayload9kO1);

    // Order O2 (unpaid)
    const order9kO2Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 98,
      tableName: 'Table 98',
      customerPhone: '9876543408',
      customerName: 'O2 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order9kO2Id = order9kO2Res.data.id;
    const payOrder9kO2Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order9kO2Id });
    const rzpOrder9kO2Id = payOrder9kO2Res.data.razorpayOrderId;

    // Attempt to replay eventId9kO1 (bound to order O1) on order O2 -> reject with HTTP 400
    const whPayload9kO1Clash = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: paymentId9kO1,
            order_id: rzpOrder9kO2Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kO1Clash = computeWebhookSignature(whPayload9kO1Clash);
    const whRes9kO1Clash = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSig9kO1Clash,
      'x-razorpay-event-id': eventId9kO1
    }, whPayload9kO1Clash);
    assert(whRes9kO1Clash.statusCode === 400, 'Test O1 (9k): Replaying existing event ID on different order rejected with HTTP 400');
    assert(whRes9kO1Clash.data.error && (whRes9kO1Clash.data.error.includes('already processed for order') || whRes9kO1Clash.data.error.includes('mismatch')), 'Test O1 (9k): Error confirms cross-order event ID rejection');

    // Order O2 on sharma-dhaba (different tenant)
    const order9kO2CrossRes = await makeRequest('POST', '/api/orders?restaurant=sharma-dhaba', {}, {
      tableId: 5,
      tableName: 'Table 5',
      customerPhone: '9876543409',
      customerName: 'O2 Sharma User',
      items: [{ id: 'sharma-dhaba_m1', qty: 1 }]
    });
    const order9kO2CrossId = order9kO2CrossRes.data.id;
    const payOrder9kO2CrossRes = await makeRequest('POST', '/api/create-payment-order?restaurant=sharma-dhaba', {}, { orderId: order9kO2CrossId });
    const rzpOrder9kO2CrossId = payOrder9kO2CrossRes.data.razorpayOrderId;

    // Attempt to replay eventId9kO1 (from tiptap-bistro) on sharma-dhaba -> reject with HTTP 400/403
    const whPayload9kO2Cross = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_9ko2_cross_${Date.now()}`,
            order_id: rzpOrder9kO2CrossId,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSig9kO2Cross = computeWebhookSignature(whPayload9kO2Cross);
    const whRes9kO2CrossTenant = await makeRequest('POST', '/api/payment-webhook?restaurant=sharma-dhaba', {
      'x-razorpay-signature': whSig9kO2Cross,
      'x-razorpay-event-id': eventId9kO1
    }, whPayload9kO2Cross);
    assert(whRes9kO2CrossTenant.statusCode === 403 || whRes9kO2CrossTenant.statusCode === 400, 'Test O2 (9k): Replaying event on different tenant rejected');
    assert(whRes9kO2CrossTenant.data.error && (whRes9kO2CrossTenant.data.error.includes('mismatch') || whRes9kO2CrossTenant.data.error.includes('Cross-tenant')), 'Test O2 (9k): Error confirms cross-tenant event rejection');

    // ----------------------------------------------------
    // SECTION 10: CUSTOMER UI COMPLETE UTR REMOVAL CHECK
    // ----------------------------------------------------
    console.log('\n--- 10. CUSTOMER UI (ZERO MANUAL UTR INPUT) VERIFICATION ---');
    const menuHtml = fs.readFileSync(path.resolve(__dirname, '../public/menu.html'), 'utf8');
    assert(!menuHtml.includes('inpUpiUtr'), 'Customer UI does not contain #inpUpiUtr input element');
    assert(!menuHtml.includes('submitUtrPayment'), 'Customer UI does not contain submitUtrPayment() function');
    assert(!menuHtml.includes('12-digit UPI'), 'Customer UI does not contain manual 12-digit UTR instructions');
    assert(menuHtml.includes('launchRazorpayCheckout'), 'Customer UI implements official launchRazorpayCheckout()');
    assert(menuHtml.includes('setPaymentStateUI'), 'Customer UI implements real-time state UI handler');
    assert(!menuHtml.includes('1-Tap Instant UPI'), 'Customer UI buttons do not falsely claim direct 1-tap app launch without checkout');

    // ----------------------------------------------------
    // SECTION 11: PAYMENT STATE AUTHORIZATION & TRANSITION INTEGRITY
    // ----------------------------------------------------
    console.log('\n--- 11. PAYMENT STATE AUTHORIZATION & TRANSITION INTEGRITY ---');

    // 11.1: Setup test order on Table 99
    const orderSec11Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 99,
      tableName: 'Table 99',
      customerPhone: '9876543999',
      customerName: 'Sec11 User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }] // 280 + 14 = 294
    });
    assert(orderSec11Res.statusCode === 201, 'Section 11: Setup order created on Table 99');
    const orderSec11Id = orderSec11Res.data.id;

    // Snapshot state before unauthorized/kitchen attempts
    const dbSnapBefore11 = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBefore11 = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const orderBefore11 = (stateBefore11.data.orders || []).find(o => o.id === orderSec11Id);
    const tableBefore11 = (stateBefore11.data.tables || []).find(t => t.id === 99);
    const custBefore11 = (stateBefore11.data.customers || []).find(c => c.phone === '9876543999');

    // 11.2: Kitchen PIN cannot set paymentStatus to pending, paid, or another financial state
    console.log('  [TEST 11.2]: Kitchen PIN cannot modify financial or payment state');
    // Attempt 1: Kitchen PIN setting paymentStatus: 'pending'
    const kPinRes1 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '5678'
    }, {
      paymentStatus: 'pending',
      staffPin: '5678'
    });
    assert(kPinRes1.statusCode === 401, 'Section 11: Kitchen PIN setting paymentStatus: pending strictly rejected with HTTP 401');
    assert(kPinRes1.data.error && kPinRes1.data.error.includes('Cashier / Manager PIN required'), 'Section 11: Error confirms counter authorization required');

    // Attempt 2: Kitchen PIN setting paymentStatus: 'paid'
    const kPinRes2 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '5678'
    }, {
      paymentStatus: 'paid',
      staffPin: '5678'
    });
    assert(kPinRes2.statusCode === 401, 'Section 11: Kitchen PIN setting paymentStatus: paid strictly rejected with HTTP 401');

    // Attempt 3: Kitchen PIN setting isPaid: true
    const kPinRes3 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '5678'
    }, {
      isPaid: true,
      staffPin: '5678'
    });
    assert(kPinRes3.statusCode === 401, 'Section 11: Kitchen PIN setting isPaid: true strictly rejected with HTTP 401');

    // Attempt 4: Kitchen PIN updating kitchenStatus AND sneaking paymentStatus
    const kPinRes4 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '5678'
    }, {
      kitchenStatus: 'preparing',
      paymentStatus: 'paid',
      staffPin: '5678'
    });
    assert(kPinRes4.statusCode === 401, 'Section 11: Kitchen PIN sneaked paymentStatus in kitchen update strictly rejected with HTTP 401');

    // Attempt 5: Kitchen PIN modifying paymentMethod
    const kPinRes5 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '5678'
    }, {
      paymentMethod: 'cash',
      staffPin: '5678'
    });
    assert(kPinRes5.statusCode === 401, 'Section 11: Kitchen PIN modifying paymentMethod strictly rejected with HTTP 401');

    // 11.3: Unauthorized users cannot change isPaid or financial state
    console.log('  [TEST 11.3]: Unauthorized users cannot modify isPaid or payment state');
    // No credentials
    const unauthRes1 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {}, {
      isPaid: true
    });
    assert(unauthRes1.statusCode === 401, 'Section 11: Unauthenticated request to change isPaid strictly rejected with HTTP 401');

    // Invalid PIN
    const unauthRes2 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '9999'
    }, {
      isPaid: true,
      staffPin: '9999'
    });
    assert(unauthRes2.statusCode === 401, 'Section 11: Invalid PIN to change isPaid strictly rejected with HTTP 401');

    // 11.4: Strict type and value validation
    console.log('  [TEST 11.4]: Invalid types and unsupported payment statuses are rejected');
    // String isPaid
    const typeRes1 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      isPaid: 'true',
      staffPin: '1234'
    });
    assert(typeRes1.statusCode === 400, 'Section 11: String isPaid strictly rejected with HTTP 400');
    assert(typeRes1.data.error && typeRes1.data.error.includes('must be a boolean'), 'Section 11: Error confirms isPaid boolean requirement');

    // Number isPaid
    const typeRes2 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      isPaid: 1,
      staffPin: '1234'
    });
    assert(typeRes2.statusCode === 400, 'Section 11: Number isPaid strictly rejected with HTTP 400');

    // Invalid paymentStatus
    const typeRes3 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      paymentStatus: 'fraudulent_status',
      staffPin: '1234'
    });
    assert(typeRes3.statusCode === 400, 'Section 11: Invalid paymentStatus value strictly rejected with HTTP 400');

    // Number paymentStatus
    const typeRes4 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      paymentStatus: 1234,
      staffPin: '1234'
    });
    assert(typeRes4.statusCode === 400, 'Section 11: Number paymentStatus strictly rejected with HTTP 400');

    // Invalid paymentMethod
    const typeRes5 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      paymentMethod: 'crypto_token',
      staffPin: '1234'
    });
    assert(typeRes5.statusCode === 400, 'Section 11: Unsupported paymentMethod strictly rejected with HTTP 400');

    // Invalid order status
    const typeRes6 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'non_existent_status',
      staffPin: '1234'
    });
    assert(typeRes6.statusCode === 400, 'Section 11: Invalid order status strictly rejected with HTTP 400');

    // Invalid kitchenStatus
    const typeRes7 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      kitchenStatus: 'eating',
      staffPin: '1234'
    });
    assert(typeRes7.statusCode === 400, 'Section 11: Invalid kitchenStatus strictly rejected with HTTP 400');

    // Verify ZERO side effects after all unauthorized and invalid attempts
    const stateAfterInvalid = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const orderAfterInvalid = (stateAfterInvalid.data.orders || []).find(o => o.id === orderSec11Id);
    const tableAfterInvalid = (stateAfterInvalid.data.tables || []).find(t => t.id === 99);
    const custAfterInvalid = (stateAfterInvalid.data.customers || []).find(c => c.phone === '9876543999');

    assert(orderAfterInvalid && orderAfterInvalid.isPaid === false, 'Section 11: Order isPaid strictly remains false');
    assert(orderAfterInvalid && orderAfterInvalid.paymentStatus === 'unpaid', 'Section 11: Order paymentStatus strictly remains unpaid');
    assert(tableAfterInvalid && tableAfterInvalid.status === 'occupied', 'Section 11: Table 99 status unchanged');
    assert(tableAfterInvalid && tableAfterInvalid.currentOrderId === orderSec11Id, 'Section 11: Table 99 currentOrderId unchanged');
    assert(custAfterInvalid && custAfterInvalid.totalSpent === custBefore11.totalSpent, 'Section 11: Customer spend unchanged');
    assert(custAfterInvalid && custAfterInvalid.loyaltyPoints === custBefore11.loyaltyPoints, 'Section 11: Customer loyalty unchanged');

    // 11.5: Settle Order 11 via Valid Razorpay Webhook
    console.log('  [TEST 11.5]: Valid Razorpay webhook settlement still works');
    const payOrderSec11Res = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: orderSec11Id });
    assert(payOrderSec11Res.statusCode === 200, 'Section 11: Payment order created');
    const rzpOrderSec11Id = payOrderSec11Res.data.razorpayOrderId;
    const paymentIdSec11 = `pay_sec11_${Date.now()}`;
    const eventIdSec11 = `evt_sec11_${Date.now()}`;

    const whPayloadSec11 = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdSec11,
            order_id: rzpOrderSec11Id,
            amount: 29400,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    });
    const whSigSec11 = computeWebhookSignature(whPayloadSec11);
    const whResSec11 = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': whSigSec11,
      'x-razorpay-event-id': eventIdSec11
    }, whPayloadSec11);
    assert(whResSec11.statusCode === 200, 'Section 11: Valid Razorpay webhook accepted with HTTP 200');
    assert(whResSec11.data.settled === true, 'Section 11: Webhook reports settled: true');

    const stateAfterRzp = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const orderAfterRzp = (stateAfterRzp.data.orders || []).find(o => o.id === orderSec11Id);
    assert(orderAfterRzp && orderAfterRzp.isPaid === true, 'Section 11: Order isPaid is true after webhook');
    assert(orderAfterRzp && orderAfterRzp.paymentStatus === 'paid', 'Section 11: Order paymentStatus is paid after webhook');
    assert(orderAfterRzp && orderAfterRzp.txnId === paymentIdSec11, 'Section 11: Order txnId matches paymentId');

    // 11.6: Ordinary staff cannot reverse a Razorpay-settled order
    console.log('  [TEST 11.6]: Ordinary staff cannot reverse a Razorpay-settled order');
    const dbSnapBeforeRev = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateBeforeRev = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const payRecordBeforeRev = JSON.stringify(dbSnapBeforeRev.processedPayments[paymentIdSec11]);
    const evtRecordBeforeRev = JSON.stringify(dbSnapBeforeRev.processedWebhookEvents[eventIdSec11]);
    const custBeforeRev = (stateBeforeRev.data.customers || []).find(c => c.phone === '9876543999');
    const tableBeforeRev = (stateBeforeRev.data.tables || []).find(t => t.id === 99);

    // Attempt 6a: Ordinary staff PATCH setting isPaid: false without test override flag
    const revRes1 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      isPaid: false,
      staffPin: '1234'
    });
    assert(revRes1.statusCode === 400, 'Section 11: Ordinary staff setting isPaid: false on settled order rejected with HTTP 400');
    assert(revRes1.data.error && revRes1.data.error.includes('Reversing a settled or paid order'), 'Section 11: Error confirms reversal rejected');

    // Attempt 6b: Ordinary staff PATCH setting paymentStatus: 'pending' without test override flag
    const revRes2 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      paymentStatus: 'pending',
      staffPin: '1234'
    });
    assert(revRes2.statusCode === 400, 'Section 11: Ordinary staff setting paymentStatus: pending on settled order rejected with HTTP 400');

    // Attempt 6c: Ordinary staff PATCH setting paymentStatus: 'unpaid'
    const revRes3 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      paymentStatus: 'unpaid',
      staffPin: '1234'
    });
    assert(revRes3.statusCode === 400, 'Section 11: Ordinary staff setting paymentStatus: unpaid on settled order rejected with HTTP 400');

    // Attempt 6d: Ordinary staff modifying txnId on settled order
    const revRes4 = await makeRequest('PATCH', `/api/orders/${orderSec11Id}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      txnId: null,
      staffPin: '1234'
    });
    assert(revRes4.statusCode === 400, 'Section 11: Ordinary staff clearing txnId on settled order rejected with HTTP 400');

    // Verify ZERO side effects after reversal attempts
    const dbSnapAfterRev = JSON.parse(fs.readFileSync(tempDbPath, 'utf8'));
    const stateAfterRev = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const orderAfterRev = (stateAfterRev.data.orders || []).find(o => o.id === orderSec11Id);
    const tableAfterRev = (stateAfterRev.data.tables || []).find(t => t.id === 99);
    const custAfterRev = (stateAfterRev.data.customers || []).find(c => c.phone === '9876543999');

    assert(JSON.stringify(dbSnapAfterRev.processedPayments[paymentIdSec11]) === payRecordBeforeRev, 'Section 11: processedPayments record unchanged after rejected reversals');
    assert(JSON.stringify(dbSnapAfterRev.processedWebhookEvents[eventIdSec11]) === evtRecordBeforeRev, 'Section 11: processedWebhookEvents record unchanged after rejected reversals');
    assert(orderAfterRev && orderAfterRev.isPaid === true, 'Section 11: Order isPaid remains strictly true');
    assert(orderAfterRev && orderAfterRev.paymentStatus === 'paid', 'Section 11: Order paymentStatus remains strictly paid');
    assert(orderAfterRev && orderAfterRev.txnId === paymentIdSec11, 'Section 11: Order txnId remains strictly unchanged');
    assert(tableAfterRev && tableAfterRev.status === tableBeforeRev.status, 'Section 11: Table status unchanged');
    assert(tableAfterRev && tableAfterRev.currentOrderId === tableBeforeRev.currentOrderId, 'Section 11: Table currentOrderId unchanged');
    assert(custAfterRev && custAfterRev.totalSpent === custBeforeRev.totalSpent, 'Section 11: Customer spend unchanged');
    assert(custAfterRev && custAfterRev.loyaltyPoints === custBeforeRev.loyaltyPoints, 'Section 11: Customer loyalty unchanged');

    // 11.7: Legitimate authorized cash settlement still works
    console.log('  [TEST 11.7]: Legitimate authorized cash settlement still works');
    const orderCashRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 100,
      tableName: 'Table 100',
      customerPhone: '9876543100',
      customerName: 'Cash User',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    assert(orderCashRes.statusCode === 201, 'Section 11: Cash test order placed on Table 100');
    const orderCashId = orderCashRes.data.id;

    // Authorized counter staff settles order via cash settlement workflow
    const cashSettleRes = await makeRequest('PATCH', `/api/orders/${orderCashId}?restaurant=tiptap-bistro`, {
      'x-staff-pin': '1234'
    }, {
      status: 'paid',
      closeTable: true,
      paymentMethod: 'cash',
      staffPin: '1234'
    });
    assert(cashSettleRes.statusCode === 200, 'Section 11: Authorized counter cash settlement accepted with HTTP 200');
    assert(cashSettleRes.data.order && cashSettleRes.data.order.isPaid === true, 'Section 11: Cash settled order marked isPaid: true');
    assert(cashSettleRes.data.order && cashSettleRes.data.order.paymentStatus === 'paid', 'Section 11: Cash settled order paymentStatus marked paid');
    assert(cashSettleRes.data.order && cashSettleRes.data.order.paymentMethod === 'cash', 'Section 11: Cash settled order paymentMethod marked cash');

    // Verify Table 100 transitioned to cleaning and freed
    const stateAfterCash = await makeRequest('GET', '/api/state?restaurant=tiptap-bistro', { 'x-staff-pin': '1234' });
    const table100After = (stateAfterCash.data.tables || []).find(t => t.id === 100);
    assert(table100After && table100After.status === 'cleaning', 'Section 11: Table 100 transitioned to cleaning');
    assert(table100After && table100After.currentOrderId === null, 'Section 11: Table 100 currentOrderId cleared');

    // Verify customer lifetime spend updated exactly once for cash settlement
    const cust100After = (stateAfterCash.data.customers || []).find(c => c.phone === '9876543100');
    assert(cust100After && cust100After.totalSpent === 294, 'Section 11: Customer spend updated exactly once for cash payment (294)');
    assert(cust100After && cust100After.loyaltyPoints === 29, 'Section 11: Customer loyalty updated exactly once for cash payment (29)');

    console.log('\n================================================================');
    console.log(`🏁 PHASE 10 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  } finally {
    serverProc.kill('SIGTERM');
    cleanup();
    const finalHash = crypto.createHash('sha256').update(getInitialRaw()).digest('hex');
    if (initialHash !== finalHash) {
      console.error('CRITICAL ERROR: data/tiptap-db.json baseline was modified!');
      process.exit(1);
    } else {
      console.log('🛡️  ISOLATION VERIFIED: data/tiptap-db.json remained 100% UNTOUCHED (zero disk mutations)\n');
    }
  }
}

runPhase10Tests();
