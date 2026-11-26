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
