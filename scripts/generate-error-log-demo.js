import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.js';

// Local demonstration only: never reads .env or calls a deployed service.
const apiKey = randomBytes(32).toString('hex');
const projectRoot = new URL('../', import.meta.url);
const outputDirectory = new URL('docs/examples/error-handling/', projectRoot);
const logs = [];
const responses = [];
const validBody = JSON.stringify({ zone: 'local', weightGrams: 1000 });
const scenarios = [
  { name: 'successful-quote', status: 200 },
  { name: 'missing-credentials', status: 401, layer: 'authentication', authenticated: false },
  { name: 'malformed-json', status: 400, layer: 'parsing', body: 'private-demo-body' },
  { name: 'invalid-quote', status: 422, layer: 'validation', body: '{}' },
  { name: 'unknown-route', status: 404, layer: 'routing', path: '/missing' },
  { name: 'unsupported-method', status: 405, layer: 'routing', method: 'GET' },
  { name: 'unsupported-content-type', status: 415, layer: 'content_type', contentType: 'text/plain' },
  { name: 'oversized-body', status: 413, layer: 'body', body: JSON.stringify({ data: 'x'.repeat(5000) }) },
  { name: 'quota-exceeded', status: 429, layer: 'rate_limit', options: { rateLimit: 0 } },
  {
    name: 'simulated-service-failure', status: 500, layer: 'quote_service',
    options: { quoteCalculator: () => {
      const cause = new Error('Demo dependency timeout (simulated; no external call).');
      cause.code = 'ETIMEDOUT';
      throw new Error('Demo rate provider unavailable.', { cause });
    } }
  },
  {
    name: 'simulated-response-failure', status: 500, layer: 'http',
    options: { quoteCalculator: () => ({ amount: 1n }) }
  }
];

for (const scenario of scenarios) {
  const events = [];
  const server = createApp({ apiKey, logger: event => events.push(event), ...scenario.options });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const headers = { 'content-type': scenario.contentType ?? 'application/json' };
    if (scenario.authenticated !== false) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${scenario.path ?? '/v1/quotes'}`, {
      method: scenario.method ?? 'POST', headers,
      body: scenario.method === 'GET' ? undefined : scenario.body ?? validBody,
      signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    const requestId = response.headers.get('x-request-id');
    assert.equal(response.status, scenario.status);
    assert.equal(events.filter(event => event.event === 'request_completed').length, 1);
    const failures = events.filter(event => event.event === 'request_failed');
    assert.equal(failures.length, scenario.layer ? 1 : 0);
    if (scenario.layer) {
      assert.equal(failures[0].layer, scenario.layer);
      assert.equal(body.requestId, requestId);
      assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'requestId']);
      assert.ok(!JSON.stringify(body).includes(failures[0].error.message));
    }
    for (const event of events) {
      assert.equal(event.requestId, requestId);
      assert.deepEqual(event.caller, {
        id: scenario.authenticated === false ? null : 'shared-api-client',
        authenticated: scenario.authenticated !== false, ip: '127.0.0.1'
      });
    }
    logs.push(...events);
    responses.push({ scenario: scenario.name, status: response.status, requestId, body });
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

// Preserve real events but replace this workstation's absolute source paths.
const localPath = fileURLToPath(projectRoot).replaceAll('\\', '/');
const localUrl = projectRoot.href;
function publishable(value) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('\\', '/').split(localUrl).join('file:///<project>/')
    .split(localPath).join('<project>/');
}
const logText = logs.map(event => JSON.stringify(event, (key, value) => publishable(value))).join('\n') + '\n';
const responseText = JSON.stringify(responses, null, 2) + '\n';
for (const text of [logText, responseText]) {
  assert.ok(!text.includes(apiKey));
  assert.ok(!text.includes('private-demo-body'));
  assert.ok(!text.includes(localPath));
  assert.ok(!text.includes(localUrl));
}
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL('error-handling.sample.log', outputDirectory), logText);
await writeFile(new URL('client-responses.json', outputDirectory), responseText);
console.log(`Generated ${logs.length} log events from ${scenarios.length} verified local scenarios in docs/examples/error-handling/.`);
