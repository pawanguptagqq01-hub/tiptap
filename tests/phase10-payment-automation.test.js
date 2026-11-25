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
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order3Id = order3Res.data.id;
    const payOrder3 = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order3Id });
    const rzpOrder3Id = payOrder3.data.razorpayOrderId;

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
    // SECTION 7: CHECKOUT SIGNATURE & PROVIDER STATUS VERIFICATION
    // ----------------------------------------------------
    console.log('\n--- 7. CHECKOUT SIGNATURE & PROVIDER STATUS VERIFICATION ---');

    // 7a. Forged checkout signature rejected
    const paymentId3 = `pay_checkout_${Date.now()}`;
    const forgedCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: paymentId3,
      razorpay_signature: 'fake_forged_client_signature_hex'
    });
    assert(forgedCheckout.statusCode === 400, 'Forged client checkout signature rejected with HTTP 400 Bad Request');

    // 7b. Mismatched order ID rejected
    const validCheckoutSig = computeCheckoutSignature(rzpOrder3Id, paymentId3);
    const mismatchedCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: 'order_DIFFERENT_MISMATCHED',
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(mismatchedCheckout.statusCode === 400, 'Mismatched razorpay_order_id rejected with HTTP 400 Bad Request');

    // 7c. Authorized-only payment status rejected
    const authOnlyPaymentId = `pay_auth_only_${Date.now()}`;
    const authOnlySig = computeCheckoutSignature(rzpOrder3Id, authOnlyPaymentId);
    const authOnlyRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: authOnlyPaymentId,
      razorpay_signature: authOnlySig
    });
    assert(authOnlyRes.statusCode === 400, 'Authorized-only payment rejected with HTTP 400 Bad Request');
    assert(authOnlyRes.data.status === 'authorized', 'Rejection reports provider status is authorized');

    // Verify order remains unpaid after authorized-only payment attempt
    const checkAuthOnlyState = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${order3Id}`);
    const authOnlyOrd = (checkAuthOnlyState.data.orders || []).find(o => o.id === order3Id);
    assert(authOnlyOrd && authOnlyOrd.isPaid === false, 'Order remains unpaid after authorized-only payment rejection');

    // 7d. Failed status payment rejected
    const failedStatusPaymentId = `pay_failed_status_${Date.now()}`;
    const failedStatusSig = computeCheckoutSignature(rzpOrder3Id, failedStatusPaymentId);
    const failedStatusRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: failedStatusPaymentId,
      razorpay_signature: failedStatusSig
    });
    assert(failedStatusRes.statusCode === 400, 'Failed provider status rejected with HTTP 400 Bad Request');

    // 7e. Provider timeout / error leaves order unpaid with pending status
    const timeoutPaymentId = `pay_provider_timeout_${Date.now()}`;
    const timeoutSig = computeCheckoutSignature(rzpOrder3Id, timeoutPaymentId);
    const timeoutRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: timeoutPaymentId,
      razorpay_signature: timeoutSig
    });
    assert(timeoutRes.statusCode === 502 || timeoutRes.statusCode === 504 || timeoutRes.statusCode === 400, 'Provider timeout/error returns safe non-settlement status');
    assert(timeoutRes.data.status === 'pending_verification', 'Returns pending_verification status');

    // 7f. Authentic signature with captured status settles order
    const validCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(validCheckout.statusCode === 200, 'Valid cryptographically signed Checkout callback accepted (HTTP 200)');
    assert(validCheckout.data.verified === true, 'Checkout verification response confirms verified: true');
    assert(validCheckout.data.order.isPaid === true, 'Order marked isPaid: true via verified signature & captured status');

    // 7g. Idempotent re-submission
    const repeatCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(repeatCheckout.statusCode === 200, 'Repeated client signature submission acknowledged with HTTP 200');

    // ----------------------------------------------------
    // SECTION 8: CROSS-TENANT ORDER BINDING INTEGRITY
    // ----------------------------------------------------
    console.log('\n--- 8. CROSS-TENANT PAYMENT ASSOCIATION INTEGRITY ---');
    const crossRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=sharma-dhaba', {}, {
      orderId: order3Id, // tiptap-bistro order
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: `pay_cross_${Date.now()}`,
      razorpay_signature: validCheckoutSig
    });
    assert(crossRes.statusCode === 404, 'Cross-tenant order verification rejected with HTTP 404 Not Found');

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
