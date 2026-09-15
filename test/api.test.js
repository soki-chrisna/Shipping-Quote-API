import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { calculateQuote, createApp } from '../src/app.js';

const key = 'test-only-key-with-at-least-32-characters';
async function fixture(t, options = {}) {
  const app = createApp({ apiKey: key, logger: () => {}, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return (body = { zone: 'domestic', weightGrams: 1500 }, init = {}) =>
    fetch(`http://127.0.0.1:${app.address().port}${init.path ?? '/v1/quotes'}`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), ...init
    });
}
test('rounds up billable weight, including boundaries', () => {
  for (const [grams, amount] of [[1,10000],[1000,10000],[1001,20000],[30000,300000]]) {
    assert.equal(calculateQuote({ zone: 'local', weightGrams: grams }).amount, amount);
  }
});
test('rejects invalid values and client-controlled prices', () => {
  for (const body of [null, [], {}, { zone: '__proto__', weightGrams: 1 },
    { zone: ['local'], weightGrams: 1000 },
    { zone: 'local', weightGrams: '1000' }, { zone: 'local', weightGrams: -1 },
    { zone: 'local', weightGrams: 30001 }, { zone: 'local', weightGrams: 1.5 },
    { zone: 'local', weightGrams: 10, amount: 0 }]) assert.throws(() => calculateQuote(body));
});
test('refuses weak or placeholder configuration', () => {
  for (const apiKey of [undefined, 'short', 'replace-with-at-least-32-random-characters']) {
    assert.throws(() => createApp({ apiKey }));
  }
});
test('consumer contract returns a deterministic IDR quote', async t => {
  const request = await fixture(t);
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { currency: 'IDR', amount: 50000, billableKg: 2, rateVersion: '2026-01' });
  assert.ok(res.headers.get('x-request-id'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
test('missing and incorrect credentials are rejected', async t => {
  const request = await fixture(t);
  for (const authorization of ['', 'Bearer incorrect']) {
    assert.equal((await request({}, { headers: { authorization } })).status, 401);
  }
});
test('JSON, content type, schema, method, route and size errors', async t => {
  const request = await fixture(t);
  assert.equal((await request({}, { body: '{' })).status, 400);
  assert.equal((await request({}, { headers: { authorization: `Bearer ${key}` } })).status, 415);
  assert.equal((await request({})).status, 422);
  assert.equal((await request({}, { method: 'GET', body: undefined })).status, 405);
  assert.equal((await request({}, { path: '/missing' })).status, 404);
  assert.equal((await request({ data: 'x'.repeat(5000) })).status, 413);
});
test('rate limit resets and health stays available', async t => {
  let time = 0;
  const request = await fixture(t, { rateLimit: 1, windowMs: 1000, now: () => time });
  assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal((await request({}, { path: '/healthz', method: 'GET', body: undefined, headers: {} })).status, 200);
  time = 1000;
  assert.equal((await request()).status, 200);
});
test('logs exclude credentials and request bodies', async t => {
  const logs = [];
  const request = await fixture(t, { logger: event => logs.push(event) });
  await request();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 200);
  assert.ok(!JSON.stringify(logs).includes(key));
  assert.ok(!JSON.stringify(logs).includes('domestic'));
});
test('real checkout process succeeds and fails closed on authentication failure', async t => {
  const app = createApp({ apiKey: key, logger: () => {} });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const run = promisify(execFile);
  const env = { ...process.env, API_KEY: key, API_BASE_URL: `http://127.0.0.1:${app.address().port}` };
  for (const color of ['0', '1']) {
    const success = await run(process.execPath, ['examples/checkout-client.js'], {
      env: { ...env, FORCE_COLOR: color }
    });
    // Console colors must not affect assertions about the checkout total.
    assert.match(stripVTControlCharacters(success.stdout), /total: 250000/);
  }
  await assert.rejects(run(process.execPath, ['examples/checkout-client.js'], {
    env: { ...env, API_KEY: 'wrong' }
  }), error => error.code === 1 && /Checkout paused:.*401/.test(error.stderr));
});
