import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';

import { createApp } from '../src/app.js';
import { calculateQuote } from '../src/quote.js';

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
  assert.ok(!serializedLogs.includes(API_KEY));
  assert.ok(!serializedLogs.includes('domestic'));
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
