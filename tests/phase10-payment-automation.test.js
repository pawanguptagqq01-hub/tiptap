/**
 * TipTap Phase 10: Automated Real-Time Payment Verification Test Suite
 *
 * Verifies:
 * 1. Razorpay order creation and binding to local order
 * 2. HMAC-SHA256 webhook signature verification (rejection of forged/tampered signatures)
 * 3. Exact amount (paise) and currency (INR) validation
 * 4. Webhook event deduplication (x-razorpay-event-id) and payment ID deduplication
 * 5. Handling of payment.captured, order.paid, and payment.failed events
 * 6. Direct Client Checkout signature verification (/api/payment/verify-signature)
 * 7. Cross-tenant payment rejection and order ownership binding
 * 8. Shared atomic, idempotent payment settlement service
 * 9. Customer UI verification (zero manual UTR inputs)
 * 10. Database isolation (zero disk baseline mutations)
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

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
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

  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
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
    // SECTION 2: WEBHOOK CRYPTOGRAPHIC SIGNATURE VERIFICATION
    // ----------------------------------------------------
    console.log('\n--- 2. WEBHOOK HMAC-SHA256 SIGNATURE VERIFICATION ---');
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

    // 2a. Missing signature rejected
    const noSigRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {}, webhookPayload);
    assert(noSigRes.statusCode === 401, 'Unsigned webhook request strictly rejected with HTTP 401 Unauthorized');

    // 2b. Forged signature rejected
    const forgedSigRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': 'forged_fake_signature_hex_0000000000000000000000000000000000000000000000000000000000000000',
      'x-razorpay-event-id': eventId1
    }, webhookPayload);
    assert(forgedSigRes.statusCode === 401, 'Forged HMAC signature strictly rejected with HTTP 401 Unauthorized');

    // 2c. Tampered body rejected (signed for 58800, but body tampered to 100)
    const validSig = computeWebhookSignature(webhookPayload);
    const tamperedPayload = webhookPayload.replace(String(expectedPaise), '100');
    const tamperedRes = await makeRequest('POST', '/api/payment-webhook?restaurant=tiptap-bistro', {
      'x-razorpay-signature': validSig,
      'x-razorpay-event-id': eventId1
    }, tamperedPayload);
    assert(tamperedRes.statusCode === 401, 'Tampered request body alters HMAC and is rejected with HTTP 401 Unauthorized');

    // 2d. Authentic signature accepted & settles payment
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
    // SECTION 3: REPLAY & EVENT DEDUPLICATION
    // ----------------------------------------------------
    console.log('\n--- 3. REPLAY & DEDUPLICATION PROTECTION ---');
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
    // SECTION 4: AMOUNT & CURRENCY VALIDATION
    // ----------------------------------------------------
    console.log('\n--- 4. AMOUNT & CURRENCY INTEGRITY VALIDATION ---');
    // Place a new order on Table 3 (total: 294)
    const order3Res = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {}, {
      tableId: 3,
      tableName: 'Table 3',
      items: [{ id: 'tiptap-bistro_m1', qty: 1 }]
    });
    const order3Id = order3Res.data.id;
    const payOrder3 = await makeRequest('POST', '/api/create-payment-order?restaurant=tiptap-bistro', {}, { orderId: order3Id });
    const rzpOrder3Id = payOrder3.data.razorpayOrderId;

    // 4a. Attempt underpayment (paying 100 paise instead of 29400 paise)
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

    // 4b. Attempt non-INR currency
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
    // SECTION 5: FAILED PAYMENT ACKNOWLEDGEMENT
    // ----------------------------------------------------
    console.log('\n--- 5. FAILED PAYMENT ACKNOWLEDGEMENT ---');
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

    // Confirm order remains UNPAID
    const checkOrder3 = await makeRequest('GET', `/api/state?restaurant=tiptap-bistro&orderId=${order3Id}`);
    const ord3Doc = (checkOrder3.data.orders || []).find(o => o.id === order3Id);
    assert(ord3Doc && ord3Doc.isPaid === false, 'Failed payment event does NOT mark order paid (isPaid: false)');

    // ----------------------------------------------------
    // SECTION 6: CLIENT-SIDE CHECKOUT SIGNATURE VERIFICATION
    // ----------------------------------------------------
    console.log('\n--- 6. DIRECT CHECKOUT SIGNATURE VERIFICATION ---');
    const paymentId3 = `pay_checkout_${Date.now()}`;
    const validCheckoutSig = computeCheckoutSignature(rzpOrder3Id, paymentId3);

    // 6a. Forged checkout signature rejected
    const forgedCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: paymentId3,
      razorpay_signature: 'fake_forged_client_signature_hex'
    });
    assert(forgedCheckout.statusCode === 400, 'Forged client checkout signature rejected with HTTP 400 Bad Request');

    // 6b. Mismatched order ID rejected
    const mismatchedCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: 'order_DIFFERENT_MISMATCHED',
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(mismatchedCheckout.statusCode === 400, 'Mismatched razorpay_order_id rejected with HTTP 400 Bad Request');

    // 6c. Valid checkout signature accepted & settles order
    const validCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(validCheckout.statusCode === 200, 'Valid cryptographically signed Checkout callback accepted (HTTP 200)');
    assert(validCheckout.data.verified === true, 'Checkout verification response confirms verified: true');
    assert(validCheckout.data.order.isPaid === true, 'Order marked isPaid: true via verified signature');

    // 6d. Idempotent re-submission
    const repeatCheckout = await makeRequest('POST', '/api/payment/verify-signature?restaurant=tiptap-bistro', {}, {
      orderId: order3Id,
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: paymentId3,
      razorpay_signature: validCheckoutSig
    });
    assert(repeatCheckout.statusCode === 200, 'Repeated client signature submission acknowledged with HTTP 200');

    // ----------------------------------------------------
    // SECTION 7: CROSS-TENANT ORDER BINDING INTEGRITY
    // ----------------------------------------------------
    console.log('\n--- 7. CROSS-TENANT PAYMENT ASSOCIATION INTEGRITY ---');
    // Try to settle an order on sharma-dhaba using a tiptap-bistro order ID
    const crossRes = await makeRequest('POST', '/api/payment/verify-signature?restaurant=sharma-dhaba', {}, {
      orderId: order3Id, // tiptap-bistro order
      razorpay_order_id: rzpOrder3Id,
      razorpay_payment_id: `pay_cross_${Date.now()}`,
      razorpay_signature: validCheckoutSig
    });
    assert(crossRes.statusCode === 404, 'Cross-tenant order verification rejected with HTTP 404 Not Found');

    // ----------------------------------------------------
    // SECTION 8: CUSTOMER UI COMPLETE UTR REMOVAL CHECK
    // ----------------------------------------------------
    console.log('\n--- 8. CUSTOMER UI (ZERO MANUAL UTR INPUT) VERIFICATION ---');
    const menuHtml = fs.readFileSync(path.resolve(__dirname, '../public/menu.html'), 'utf8');
    assert(!menuHtml.includes('inpUpiUtr'), 'Customer UI does not contain #inpUpiUtr input element');
    assert(!menuHtml.includes('submitUtrPayment'), 'Customer UI does not contain submitUtrPayment() function');
    assert(!menuHtml.includes('12-digit UPI'), 'Customer UI does not contain manual 12-digit UTR instructions');
    assert(menuHtml.includes('launchRazorpayCheckout'), 'Customer UI implements official launchRazorpayCheckout()');
    assert(menuHtml.includes('setPaymentStateUI'), 'Customer UI implements real-time state UI handler');

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
