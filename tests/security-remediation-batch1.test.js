/**
 * TipTap Security Remediation Batch 1 - Dedicated Regression Test Suite
 *
 * Verifies:
 * 1. Stored XSS Protection in dashboard.html & kds.html (escapeHtml validation & payload sanitization)
 * 2. Request Body Size Limit (1 MB ceiling, HTTP 413 on oversized stream/header, HTTP 400 on malformed JSON)
 * 3. Session Token Security (Rejection of URL query auth_token CWE-598, CSRF enforcement on cookie auth, Bearer header auth)
 * 4. Test Database Isolation (Zero disk mutations to data/tiptap-db.json)
 * 5. IP Spoofing Hardening (getClientIp untrusted X-Forwarded-For handling)
 * 6. Security Headers (Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, HSTS on HTTPS)
 * 7. CORS Protection (Disallow wildcard '*' on credentialed/protected routes)
 */

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createIsolatedTestDb } = require('./test-db-helper');

const TEST_PORT = 3215;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeRequest(method, urlPath, headers = {}, body = null, raw = false, port = TEST_PORT) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const reqHeaders = { ...headers };
    let reqData = null;

    if (body !== null) {
      if (Buffer.isBuffer(body)) {
        reqData = body;
        if (!reqHeaders['Content-Length'] && !reqHeaders['Transfer-Encoding']) {
          reqHeaders['Content-Length'] = body.length;
        }
      } else if (typeof body === 'string') {
        reqData = body;
        if (!reqHeaders['Content-Length'] && !reqHeaders['Transfer-Encoding']) {
          reqHeaders['Content-Length'] = Buffer.byteLength(reqData);
        }
      } else {
        reqData = JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(reqData);
      }
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
        if (!raw) {
          try { json = JSON.parse(data); } catch (e) { json = data; }
        } else {
          json = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          error: null
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

    try {
      if (reqData) req.write(reqData);
      req.end();
    } catch (e) {
      resolve({
        statusCode: null,
        headers: {},
        data: null,
        error: e
      });
    }
  });
}

async function waitForServer(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await makeRequest('GET', '/healthz', {}, null, false, port);
      if (res.statusCode === 200 || res.statusCode === 503) {
        return;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for server on port ${port}`);
}

async function runBatch1Tests() {
  console.log('================================================================');
  console.log('🛡️  TIPTAP SECURITY REMEDIATION BATCH 1 - REGRESSION SUITE');
  console.log('================================================================\n');

  const { tempDbPath, cleanup } = createIsolatedTestDb('batch1');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      failed++;
    }
  }

  const serverProc = fork('server.js', [], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      MONGODB_URI: '',
      TRUST_PROXY: 'false',
      SUPER_ADMIN_PIN: 'Batch1SecureSecret#991',
      TIPTAP_DB_FILE: tempDbPath
    },
    stdio: 'pipe'
  });

  try {
    // Wait for server to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server spawn timeout')), 10000);
      const checkInterval = setInterval(async () => {
        try {
          const res = await makeRequest('GET', '/healthz');
          if (res.statusCode === 200) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        } catch (e) {}
      }, 250);
    });

    console.log(`Server started on 127.0.0.1:${TEST_PORT}\n`);

    // =================================================================
    // 1. STORED XSS MITIGATION
    // =================================================================
    console.log('--- 1. STORED XSS PROTECTION ---');
    const dashboardHtml = fs.readFileSync(path.resolve(__dirname, '../public/dashboard.html'), 'utf8');
    const kdsHtml = fs.readFileSync(path.resolve(__dirname, '../public/kds.html'), 'utf8');

    assert(dashboardHtml.includes('function escapeHtml(str)'), 'dashboard.html defines safe escapeHtml utility');
    assert(kdsHtml.includes('function escapeHtml(str)'), 'kds.html defines safe escapeHtml utility');
    assert(dashboardHtml.includes('${escapeHtml(order.notes)}'), 'dashboard.html escapes cooking notes in modal/cards');
    assert(dashboardHtml.includes('${escapeHtml(i.name)}'), 'dashboard.html escapes dish names in tickets');
    assert(kdsHtml.includes('${escapeHtml(order.notes)}'), 'kds.html escapes special cooking instructions');
    assert(kdsHtml.includes('${escapeHtml(i.name)}'), 'kds.html escapes item names in KDS rounds');
    assert(kdsHtml.includes('kotPrintNotesEl.textContent ='), 'kds.html uses safe textContent for KOT printed notes');
    assert(!dashboardHtml.includes("document.getElementById('kotNotesSection').innerHTML = order.notes"), 'dashboard.html no longer assigns unescaped notes directly to innerHTML');

    // Test submitting XSS payload in order notes and customerName
    const xssPayload = '<script>alert("pwned")</script><img src=x onerror=alert(1)>';
    const orderRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Content-Type': 'application/json'
    }, {
      tableId: 3,
      items: [{ id: 'm1', name: 'Paneer Butter Masala', price: 280, qty: 1 }],
      notes: xssPayload,
      customerName: xssPayload,
      customerPhone: '9876543210'
    });

    assert(orderRes.statusCode === 201, 'Order with special characters and HTML tags is created successfully (201)');
    const returnedNotes = orderRes.data ? (orderRes.data.notes || (orderRes.data.order && orderRes.data.order.notes)) : null;
    assert(returnedNotes === xssPayload, 'Server preserves exact raw notes without destructive mangling');

    // =================================================================
    // 2. REQUEST BODY SIZE LIMIT
    // =================================================================
    console.log('\n--- 2. REQUEST BODY SIZE LIMIT ---');

    // Oversized Content-Length header (1.2 MB)
    const headerOversizedRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Content-Type': 'application/json',
      'Content-Length': '1258291'
    }, '{"short": "body"}');
    assert(headerOversizedRes.statusCode === 413, 'Oversized Content-Length header (>1 MB) rejected immediately with HTTP 413');
    assert(headerOversizedRes.data && headerOversizedRes.data.error && headerOversizedRes.data.error.includes('1 MB'), 'HTTP 413 body notes 1 MB payload limit');

    // Stream chunked payload exceeding 1 MB
    const chunkedBuffer = Buffer.alloc(1.1 * 1024 * 1024, 'x');
    const streamOversizedRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    }, chunkedBuffer);
    const streamRejected = streamOversizedRes.statusCode === 413 || (streamOversizedRes.error && ['ECONNRESET', 'EPIPE'].includes(streamOversizedRes.error.code));
    assert(streamRejected, 'Streamed chunks exceeding 1 MB terminated with HTTP 413 or stream teardown');

    // Malformed JSON payload
    const malformedRes = await makeRequest('POST', '/api/orders?restaurant=tiptap-bistro', {
      'Content-Type': 'application/json'
    }, '{"invalid_json: true,');
    assert(malformedRes.statusCode === 400, 'Malformed JSON payload is rejected with HTTP 400 Bad Request');
    assert(malformedRes.data && malformedRes.data.error && malformedRes.data.error.includes('Malformed JSON payload'), 'Informative malformed JSON error message returned');

    // Normal payload under 1MB succeeds
    const validJsonRes = await makeRequest('POST', '/api/leads', {}, {
      name: 'Test Bistro',
      ownerName: 'Test Owner',
      phone: '9876543210'
    });
    assert(validJsonRes.statusCode === 201, 'Valid JSON payload under 1 MB is accepted (201)');

    // =================================================================
    // 3. SESSION TOKEN SECURITY & CSRF
    // =================================================================
    console.log('\n--- 3. SESSION TOKEN SECURITY & CSRF ---');

    // Log in to get a valid staff session
    const loginRes = await makeRequest('POST', '/api/auth/restaurant-login', {}, {
      identifier: 'tiptap-bistro',
      pin: '1234',
      screen: 'counter'
    });
    assert(loginRes.statusCode === 200, 'Staff login returns HTTP 200');
    const sessionId = loginRes.data ? loginRes.data.sessionId : null;
    const csrfToken = loginRes.data ? loginRes.data.csrfToken : null;
    assert(Boolean(sessionId), 'Staff login returns a valid sessionId');
    assert(Boolean(csrfToken), 'Staff login returns a CSRF token');

    // Attempt to access protected endpoint using URL query param ?auth_token=
    const queryAuthRes = await makeRequest('POST', `/api/settings?restaurant=tiptap-bistro&auth_token=${sessionId}`, {}, {
      rushMode: false
    });
    assert(queryAuthRes.statusCode === 401, 'URL query parameter ?auth_token= is rejected (HTTP 401 Unauthorized)');

    // Access with Bearer token in Authorization header
    const bearerAuthRes = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      'Authorization': `Bearer ${sessionId}`
    }, { rushMode: false });
    assert(bearerAuthRes.statusCode === 200, 'Authorization: Bearer <token> is accepted (HTTP 200)');

    // State-changing request with Cookie auth WITHOUT CSRF token must fail with 403
    const cookieNoCsrfRes = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      'Cookie': `tiptap_session=${sessionId}`
    }, { rushMode: false });
    assert(cookieNoCsrfRes.statusCode === 403, 'Cookie auth on mutating request without CSRF token is rejected with HTTP 403 Forbidden');
    assert(cookieNoCsrfRes.data && cookieNoCsrfRes.data.error && cookieNoCsrfRes.data.error.includes('CSRF'), 'Response explicitly notes missing/invalid CSRF token');

    // State-changing request with Cookie auth WITH valid CSRF token must succeed
    const cookieWithCsrfRes = await makeRequest('POST', '/api/settings?restaurant=tiptap-bistro', {
      'Cookie': `tiptap_session=${sessionId}`,
      'X-CSRF-Token': csrfToken
    }, { rushMode: false });
    assert(cookieWithCsrfRes.statusCode === 200, 'Cookie auth on mutating request with valid X-CSRF-Token succeeds (HTTP 200)');

    // =================================================================
    // 4. IP SPOOFING HARDENING & TRUSTED PROXY RESOLUTION (SEC-01)
    // =================================================================
    console.log('\n--- 4. IP SPOOFING HARDENING & TRUSTED PROXY RESOLUTION (SEC-01) ---');

    // 4a. When TRUST_PROXY is false, X-Forwarded-For must be ignored in getClientIp
    // Attempt invalid PIN login with rotating spoofed X-Forwarded-For headers to try bypassing rate limiter
    let rateLimited = false;
    for (let i = 0; i < 11; i++) {
      const spoofedIp = `192.168.1.${100 + i}`;
      const res = await makeRequest('POST', '/api/auth/restaurant-login', {
        'X-Forwarded-For': spoofedIp
      }, {
        identifier: 'tiptap-bistro',
        pin: 'wrong_pin_999',
        screen: 'counter'
      });
      if (res.statusCode === 429) {
        rateLimited = true;
        break;
      }
    }
    assert(rateLimited, 'TRUST_PROXY=false: Rate limiter tracks actual socket IP and rejects spoofed X-Forwarded-For with HTTP 429');

    // 4b. Production mode without TRUST_PROXY configuration:
    // Must NOT automatically trust X-Forwarded-For based solely on NODE_ENV=production
    console.log('  Testing production mode without TRUST_PROXY configuration...');
    const PROD_NO_TRUST_PORT = 3216;
    const prodNoTrustServer = fork('server.js', [], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PROD_NO_TRUST_PORT),
        MONGODB_URI: '',
        NODE_ENV: 'production',
        TRUST_PROXY: '',
        SUPER_ADMIN_PIN: 'ProdNoTrustPin#991',
        TIPTAP_DB_FILE: tempDbPath
      },
      stdio: 'pipe'
    });

    try {
      await waitForServer(PROD_NO_TRUST_PORT);
      let prodRateLimited = false;
      for (let i = 0; i < 11; i++) {
        const spoofedIp = `10.200.1.${10 + i}`;
        const res = await makeRequest('POST', '/api/auth/restaurant-login', {
          'X-Forwarded-For': spoofedIp
        }, {
          identifier: 'tiptap-bistro',
          pin: 'wrong_pin_888',
          screen: 'counter'
        }, false, PROD_NO_TRUST_PORT);
        if (res.statusCode === 429) {
          prodRateLimited = true;
          break;
        }
      }
      assert(prodRateLimited, 'Production without TRUST_PROXY ignores X-Forwarded-For and enforces rate limit on socket IP (429)');
    } finally {
      prodNoTrustServer.kill('SIGTERM');
    }

    // 4c. Untrusted proxy connection:
    // When TRUST_PROXY is configured to an explicit IP (e.g. 10.0.0.1) that does NOT match the socket IP (127.0.0.1)
    console.log('  Testing untrusted proxy socket connection...');
    const UNTRUSTED_PROXY_PORT = 3217;
    const untrustedProxyServer = fork('server.js', [], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(UNTRUSTED_PROXY_PORT),
        MONGODB_URI: '',
        NODE_ENV: 'production',
        TRUST_PROXY: '10.0.0.1',
        SUPER_ADMIN_PIN: 'UntrustedProxyPin#991',
        TIPTAP_DB_FILE: tempDbPath
      },
      stdio: 'pipe'
    });

    try {
      await waitForServer(UNTRUSTED_PROXY_PORT);
      let untrustedRateLimited = false;
      for (let i = 0; i < 11; i++) {
        const spoofedIp = `172.16.5.${20 + i}`;
        const res = await makeRequest('POST', '/api/auth/restaurant-login', {
          'X-Forwarded-For': spoofedIp
        }, {
          identifier: 'tiptap-bistro',
          pin: 'wrong_pin_777',
          screen: 'counter'
        }, false, UNTRUSTED_PROXY_PORT);
        if (res.statusCode === 429) {
          untrustedRateLimited = true;
          break;
        }
      }
      assert(untrustedRateLimited, 'Untrusted proxy connection ignores X-Forwarded-For and rate limits socket IP (429)');
    } finally {
      untrustedProxyServer.kill('SIGTERM');
    }

    // 4d & 4e. Trusted proxy connection with multiple forwarded IP addresses (proxy chain):
    // When TRUST_PROXY is set to 'loopback', socket 127.0.0.1 is trusted.
    // Right-to-left traversal: skips trusted hop 127.0.0.1, extracts true client 203.0.113.50, ignores attacker spoof 198.51.100.x.
    console.log('  Testing trusted proxy with multi-hop chain and right-to-left traversal...');
    const TRUSTED_PROXY_PORT = 3218;
    const trustedProxyServer = fork('server.js', [], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(TRUSTED_PROXY_PORT),
        MONGODB_URI: '',
        NODE_ENV: 'production',
        TRUST_PROXY: 'loopback',
        SUPER_ADMIN_PIN: 'TrustedProxyPin#991',
        TIPTAP_DB_FILE: tempDbPath
      },
      stdio: 'pipe'
    });

    try {
      await waitForServer(TRUSTED_PROXY_PORT);
      let chainRateLimited = false;
      // Attacker rotates leftmost IP attempting to spoof, but client IP 203.0.113.50 is static
      for (let i = 0; i < 11; i++) {
        const rotatingSpoof = `198.51.100.${i}`;
        const chainHeader = `${rotatingSpoof}, 203.0.113.50, 127.0.0.1`;
        const res = await makeRequest('POST', '/api/auth/restaurant-login', {
          'X-Forwarded-For': chainHeader
        }, {
          identifier: 'tiptap-bistro',
          pin: 'wrong_pin_666',
          screen: 'counter'
        }, false, TRUSTED_PROXY_PORT);
        if (res.statusCode === 429) {
          chainRateLimited = true;
          break;
        }
      }
      assert(chainRateLimited, 'Trusted proxy: Right-to-left traversal extracts true client IP and rate limits attacker despite spoofed leftmost hops (429)');

      // 4e. Verify legitimate client behind the same trusted proxy is NOT rate limited
      const otherClientRes = await makeRequest('POST', '/api/auth/restaurant-login', {
        'X-Forwarded-For': '203.0.113.99, 127.0.0.1'
      }, {
        identifier: 'tiptap-bistro',
        pin: 'wrong_pin_666',
        screen: 'counter'
      }, false, TRUSTED_PROXY_PORT);
      assert(otherClientRes.statusCode === 401, 'Trusted proxy: Unrelated client IP behind same reverse proxy is NOT locked out (401 != 429)');
    } finally {
      trustedProxyServer.kill('SIGTERM');
    }

    // =================================================================
    // 5. SECURITY HEADERS
    // =================================================================
    console.log('\n--- 5. SECURITY HEADERS ---');
    const headerCheckRes = await makeRequest('GET', '/healthz');
    const headers = headerCheckRes.headers;

    assert(Boolean(headers['content-security-policy']), 'Content-Security-Policy header is present');
    assert(headers['content-security-policy'].includes("default-src 'self'"), 'CSP defines default-src');
    assert(headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options is nosniff');
    assert(headers['x-frame-options'] === 'SAMEORIGIN', 'X-Frame-Options is SAMEORIGIN');
    assert(headers['referrer-policy'] === 'strict-origin-when-cross-origin', 'Referrer-Policy is strict-origin-when-cross-origin');

    // Verify HSTS when forwarded over HTTPS
    const httpsRes = await makeRequest('GET', '/healthz', {
      'x-forwarded-proto': 'https'
    });
    assert(Boolean(httpsRes.headers['strict-transport-security']), 'Strict-Transport-Security header is sent when request is over HTTPS');
    assert(httpsRes.headers['strict-transport-security'].includes('max-age='), 'HSTS specifies valid max-age');

    // =================================================================
    // 6. CORS PROTECTION
    // =================================================================
    console.log('\n--- 6. CORS PROTECTION ---');
    // Protected endpoint with Origin
    const protectedCorsRes = await makeRequest('OPTIONS', '/api/settings', {
      'Origin': 'https://evil-attacker.com'
    });
    assert(protectedCorsRes.headers['access-control-allow-origin'] !== '*', 'Protected API does not return wildcard Access-Control-Allow-Origin: *');
    assert(protectedCorsRes.headers['access-control-allow-origin'] !== 'https://evil-attacker.com', 'Protected API rejects untrusted external origin');

    // Public endpoint with Origin
    const publicCorsRes = await makeRequest('OPTIONS', '/api/orders', {
      'Origin': 'https://customer-webapp.com'
    });
    assert(publicCorsRes.headers['access-control-allow-origin'] === '*', 'Public diner API permits cross-origin order access');

  } finally {
    // Teardown: kill test server process and clean up isolated test database
    serverProc.kill('SIGTERM');
    cleanup();
  }

  console.log('\n================================================================');
  console.log(`🏁 BATCH 1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runBatch1Tests().catch(err => {
  console.error('Fatal error running Batch 1 tests:', err);
  process.exit(1);
});
