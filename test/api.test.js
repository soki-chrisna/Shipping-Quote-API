import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';

import { createApp } from '../src/app.js';
import { calculateQuote } from '../src/quote.js';
import { createSafeLogger } from '../src/errors.js';

const API_KEY = 'test-only-key-with-at-least-32-characters';
const DEFAULT_QUOTE_REQUEST = {
  zone: 'domestic',
  weightGrams: 1500
};

async function createTestClient(testContext, options = {}) {
  const server = createApp({
    apiKey: API_KEY,
    logger: () => {},
    ...options
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  testContext.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  return function requestQuote(
    body = DEFAULT_QUOTE_REQUEST,
    { path = '/v1/quotes', ...requestOptions } = {}
  ) {
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      ...requestOptions
    });
  };
}

test('rounds billable weight up to the next kilogram', () => {
  const examples = [
    [1, 10000],
    [1000, 10000],
    [1001, 20000],
    [30000, 300000]
  ];

  for (const [weightGrams, expectedAmount] of examples) {
    const quote = calculateQuote({ zone: 'local', weightGrams });
    assert.equal(quote.amount, expectedAmount);
  }
});

test('rejects invalid values and client-controlled prices', () => {
  const invalidRequests = [
    null,
    [],
    {},
    { zone: '__proto__', weightGrams: 1 },
    { zone: ['local'], weightGrams: 1000 },
    { zone: 'local', weightGrams: '1000' },
    { zone: 'local', weightGrams: -1 },
    { zone: 'local', weightGrams: 30001 },
    { zone: 'local', weightGrams: 1.5 },
    { zone: 'local', weightGrams: 10, amount: 0 }
  ];

  for (const request of invalidRequests) {
    assert.throws(() => calculateQuote(request));
  }
});

test('refuses weak or placeholder API keys', () => {
  const invalidApiKeys = [
    undefined,
    'short',
    'replace-with-at-least-32-random-characters'
  ];

  for (const apiKey of invalidApiKeys) {
    assert.throws(() => createApp({ apiKey }));
  }
});

test('returns the expected quote contract', async testContext => {
  const requestQuote = await createTestClient(testContext);
  const response = await requestQuote();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    currency: 'IDR',
    amount: 50000,
    billableKg: 2,
    rateVersion: '2026-01'
  });
  assert.ok(response.headers.get('x-request-id'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('serves public Swagger docs without consuming the business quota', async testContext => {
  const request = await createTestClient(testContext, { rateLimit: 1 });
  const get = path => request({}, { path, method: 'GET', body: undefined, headers: {} });

  for (const path of ['/docs', '/docs/']) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /SwaggerUIBundle/);
    assert.match(html, /url: '\/openapi.json'/);
    assert.ok(!html.includes(API_KEY));
  }

  const specResponse = await get('/openapi.json');
  assert.equal(specResponse.status, 200);
  assert.match(specResponse.headers.get('content-type'), /application\/json/);
  const spec = await specResponse.json();
  assert.equal(spec.openapi, '3.0.3');
  assert.deepEqual(spec.paths['/healthz'].get.security, []);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.ok(!JSON.stringify(spec).includes(API_KEY));

  // Execute the documented request and compare the documented success example.
  const operation = spec.paths['/v1/quotes'].post;
  const quote = await request(operation.requestBody.content['application/json'].example);
  assert.equal(quote.status, 200);
  assert.deepEqual(await quote.json(), operation.responses['200'].content['application/json'].example);
  assert.equal((await request()).status, 429);
  assert.equal((await get('/docs')).status, 200);
  assert.equal((await get('/openapi.json')).status, 200);
});

test('documentation routes do not bypass authentication for other methods or paths', async testContext => {
  const request = await createTestClient(testContext);
  for (const path of ['/docs', '/openapi.json', '/docs/private']) {
    assert.equal((await request({}, { path, headers: {} })).status, 401);
    assert.equal((await request({}, { path })).status, 404);
  }
});

test('keeps rate limit counters isolated between instances', async (testContext) => {
  const clientOne = await createTestClient(testContext, {
    rateLimit: 2, windowMs: 60000, now: () => 0
  });

  const clientOneResponse = await clientOne();
  assert.equal(clientOneResponse.status, 200);
  const secondClientOneResponse = await clientOne();
  assert.equal(secondClientOneResponse.status, 200);
  const thirdClientOneResponse = await clientOne();
  assert.equal(thirdClientOneResponse.status, 429);
  assert.equal(thirdClientOneResponse.headers.get('retry-after'), '60');

  const healthCheck = await clientOne({}, {
    path: '/healthz',
    method: 'GET',
    body: undefined,
    headers: {}
  });

  assert.equal(healthCheck.status, 200);

  const clientTwo = await createTestClient(testContext, {
    rateLimit: 2, windowMs: 60000, now: () => 0
  });
  const clientTwoResponse = await clientTwo();
  assert.equal(clientTwoResponse.status, 200);
  const secondClientTwoResponse = await clientTwo();
  assert.equal(secondClientTwoResponse.status, 200);
  const thirdClientTwoResponse = await clientTwo();
  assert.equal(thirdClientTwoResponse.status, 429);
  assert.equal(thirdClientTwoResponse.headers.get('retry-after'), '60');
  
  const secondHealthCheck = await clientTwo({}, {
    path: '/healthz',
    method: 'GET',
    body: undefined,
    headers: {}
  });
  assert.equal(secondHealthCheck.status, 200);
});

test('rejects missing and incorrect credentials', async testContext => {
  const requestQuote = await createTestClient(testContext);

  for (const authorization of ['', 'Bearer incorrect']) {
    const response = await requestQuote({}, { headers: { authorization } });
    assert.equal(response.status, 401);
  }
});

test('returns the correct status for malformed requests', async testContext => {
  const requestQuote = await createTestClient(testContext);

  const malformedJson = await requestQuote({}, { body: '{' });
  assert.equal(malformedJson.status, 400);

  const missingContentType = await requestQuote({}, {
    headers: { authorization: `Bearer ${API_KEY}` }
  });
  assert.equal(missingContentType.status, 415);

  const invalidSchema = await requestQuote({});
  assert.equal(invalidSchema.status, 422);

  const invalidMethod = await requestQuote({}, {
    method: 'GET',
    body: undefined
  });
  assert.equal(invalidMethod.status, 405);

  const missingRoute = await requestQuote({}, { path: '/missing' });
  assert.equal(missingRoute.status, 404);

  const oversizedBody = await requestQuote({ data: 'x'.repeat(5000) });
  assert.equal(oversizedBody.status, 413);
});

test('resets rate limits while keeping health checks available', async testContext => {
  let currentTime = 0;
  const requestQuote = await createTestClient(testContext, {
    rateLimit: 1,
    windowMs: 1000,
    now: () => currentTime
  });

  const firstRequest = await requestQuote();
  assert.equal(firstRequest.status, 200);

  const limitedRequest = await requestQuote();
  assert.equal(limitedRequest.status, 429);
  assert.equal(limitedRequest.headers.get('retry-after'), '1');

  const healthCheck = await requestQuote({}, {
    path: '/healthz',
    method: 'GET',
    body: undefined,
    headers: {}
  });
  assert.equal(healthCheck.status, 200);

  currentTime = 1000;

  const requestAfterReset = await requestQuote();
  assert.equal(requestAfterReset.status, 200);
});

test('excludes credentials and request bodies from logs', async testContext => {
  const logs = [];
  const requestQuote = await createTestClient(testContext, {
    logger: event => logs.push(event)
  });

  await requestQuote();

  const serializedLogs = JSON.stringify(logs);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 200);
  assert.deepEqual(logs[0].caller, { id: 'shared-api-client', authenticated: true, ip: '127.0.0.1' });
  assert.ok(!serializedLogs.includes(API_KEY));
  assert.ok(!serializedLogs.includes('domestic'));
});

test('returns fixed errors and logs each rejection at its originating layer', async testContext => {
  const logs = [];
  const request = await createTestClient(testContext, { logger: event => logs.push(event) });
  const cases = [
    [{}, {}, 422, 'invalid_request', 'validation'],
    [{}, { body: 'private-body-secret' }, 400, 'invalid_json', 'parsing'],
    [{}, { headers: {} }, 401, 'unauthorized', 'authentication'],
    [{}, { path: '/missing' }, 404, 'not_found', 'routing'],
    [{}, { method: 'GET', body: undefined }, 405, 'method_not_allowed', 'routing'],
    [{}, { headers: { authorization: `Bearer ${API_KEY}` } }, 415, 'use_application_json', 'content_type'],
    [{ data: 'x'.repeat(5000) }, {}, 413, 'body_too_large', 'body']
  ];
  for (const [input, options, status, code, layer] of cases) {
    const response = await request(input, options);
    const body = await response.json();
    assert.equal(response.status, status);
    assert.equal(body.error, code);
    assert.equal(typeof body.message, 'string');
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'requestId']);
    const failures = logs.filter(log => log.event === 'request_failed' && log.requestId === body.requestId);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].layer, layer);
    assert.equal(failures[0].status, status);
    for (const event of logs.filter(log => log.requestId === body.requestId)) {
      assert.deepEqual(event.caller, {
        id: status === 401 ? null : 'shared-api-client',
        authenticated: status !== 401, ip: '127.0.0.1'
      });
    }
    assert.ok(failures[0].error.stack);
    assert.ok(!JSON.stringify(body).includes(failures[0].error.message));
  }
  assert.ok(!JSON.stringify(logs).includes('private-body-secret'));
  assert.ok(!JSON.stringify(logs).includes(API_KEY));
  assert.match(logs.find(log => log.layer === 'validation').error.message, /weightGrams/);
});

test('unexpected service failures return 500 and retain internal causes for investigation', async testContext => {
  for (const thrown of [new Error('internal database detail', { cause: new Error('root failure') }), 'non-error failure']) {
    const logs = [];
    const request = await createTestClient(testContext, {
      logger: event => logs.push(event),
      quoteCalculator: async () => { throw thrown; }
    });
    const response = await request();
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      error: 'internal_error', message: 'Something went wrong. Please try again later.',
      requestId: response.headers.get('x-request-id')
    });
    const failures = logs.filter(log => log.event === 'request_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].requestId, body.requestId);
    assert.equal(failures[0].layer, 'quote_service');
    assert.equal(failures[0].caller.id, 'shared-api-client');
    assert.equal(failures[0].error.cause.message, thrown.message ?? thrown);
    if (thrown instanceof Error) {
      assert.equal(failures[0].error.cause.cause.message, 'root failure');
      assert.match(failures[0].error.cause.stack, /api.test.js/);
    }
  }
});

test('HTTP boundary catches response serialization failures', async testContext => {
  const logs = [];
  const request = await createTestClient(testContext, {
    logger: event => logs.push(event), quoteCalculator: () => ({ amount: 1n })
  });
  const response = await request();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'internal_error');
  assert.equal(logs.find(log => log.event === 'request_failed').layer, 'http');
  assert.equal(logs.find(log => log.event === 'request_failed').caller.id, 'shared-api-client');
});

test('rate limiting failures have correlated layer logs', async testContext => {
  const logs = [];
  const request = await createTestClient(testContext, { rateLimit: 0, logger: event => logs.push(event) });
  const response = await request();
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(logs[0].layer, 'rate_limit');
  assert.equal(logs[0].requestId, body.requestId);
  assert.equal(logs[0].caller.id, 'shared-api-client');
});

test('caller context is isolated and ignores spoofed identity headers on public and limited requests', async testContext => {
  const logs = [];
  const request = await createTestClient(testContext, { rateLimit: 0, logger: event => logs.push(event) });
  await Promise.all(['/healthz', '/docs', '/openapi.json', '/v1/quotes'].flatMap(path =>
    [undefined, 'Bearer wrong-secret', `Bearer ${API_KEY}`].map(async authorization => {
      const headers = { 'x-forwarded-for': '203.0.113.10', 'x-user-id': 'spoofed-user' };
      if (authorization) headers.authorization = authorization;
      const response = await request({}, { path, method: 'GET', body: undefined, headers });
      await response.text();
      assert.equal(response.status, path === '/v1/quotes' ? 429 : 200);
      const events = logs.filter(event => event.requestId === response.headers.get('x-request-id'));
      assert.equal(events.length, path === '/v1/quotes' ? 2 : 1);
      for (const event of events) {
        assert.deepEqual(event.caller, {
          id: authorization === `Bearer ${API_KEY}` ? 'shared-api-client' : null,
          authenticated: authorization === `Bearer ${API_KEY}`, ip: '127.0.0.1'
        });
      }
    })
  ));
  for (const secret of [API_KEY, 'wrong-secret', 'spoofed-user', '203.0.113.10']) {
    assert.ok(!JSON.stringify(logs).includes(secret));
  }
});

test('stderr fallback retains caller context for request completion and failure', async testContext => {
  const logs = [];
  testContext.mock.method(console, 'error', line => logs.push(JSON.parse(line)));
  const request = await createTestClient(testContext, {
    logger: () => { throw new Error('sink offline'); }
  });
  const response = await request({});
  await response.json();
  assert.equal(logs.length, 2);
  for (const event of logs) {
    assert.deepEqual(event.caller, { id: 'shared-api-client', authenticated: true, ip: '127.0.0.1' });
    assert.equal(event.requestId, response.headers.get('x-request-id'));
  }
});

test('logging sink failure preserves redacted evidence on stderr', testContext => {
  const fallback = [];
  testContext.mock.method(console, 'error', line => fallback.push(JSON.parse(line)));
  const secret = 'test-key-with-escaped-"-characters';
  const logger = createSafeLogger(() => { throw new Error('sink offline'); }, secret);
  logger({ event: 'request_failed', error: { message: `failed with ${secret}` } });
  assert.deepEqual(fallback, [{ event: 'request_failed', error: { message: 'failed with [REDACTED]' } }]);
});

test('client disconnect logs the body failure even without a response', { timeout: 5000 }, async testContext => {
  let resolveFailure;
  const failure = new Promise(resolve => { resolveFailure = resolve; });
  const server = createApp({
    apiKey: API_KEY,
    logger: event => { if (event.event === 'request_failed') resolveFailure(event); }
  });
  testContext.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const received = once(server, 'request');
  const request = http.request({
    host: '127.0.0.1', port: server.address().port, path: '/v1/quotes', method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', 'content-length': 100 }
  });
  request.on('error', () => {});
  request.write('{');
  await received;
  request.destroy();
  const event = await failure;
  assert.equal(event.layer, 'body');
  assert.equal(event.code, 'request_aborted');
  assert.equal(event.error.cause.code, 'ECONNRESET');
  assert.deepEqual(event.caller, { id: 'shared-api-client', authenticated: true, ip: '127.0.0.1' });
  assert.ok(event.requestId);
});

test('checkout succeeds and fails closed on authentication failure', async testContext => {
  const server = createApp({ apiKey: API_KEY, logger: () => {} });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  testContext.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const run = promisify(execFile);
  const environment = {
    ...process.env,
    API_KEY,
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    PORT: String(server.address().port)
  };

  await run(process.execPath, ['src/healthcheck.js'], { env: environment });

  for (const forceColor of ['0', '1']) {
    const result = await run(process.execPath, ['examples/checkout-client.js'], {
      env: { ...environment, FORCE_COLOR: forceColor }
    });

    const output = stripVTControlCharacters(result.stdout);
    assert.match(output, /total: 250000/);
  }

  await assert.rejects(
    run(process.execPath, ['examples/checkout-client.js'], {
      env: { ...environment, API_KEY: 'wrong' }
    }),
    error => error.code === 1 && /Checkout paused:.*401/.test(error.stderr)
  );
});
