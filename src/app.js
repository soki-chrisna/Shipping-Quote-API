import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const rates = Object.freeze({ local: 10000, domestic: 25000 });

export function calculateQuote(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'weightGrams,zone' ||
      typeof input.zone !== 'string' || !Object.hasOwn(rates, input.zone) ||
      !Number.isInteger(input.weightGrams) || input.weightGrams < 1 || input.weightGrams > 30000) {
    throw new Error('Use zone local/domestic and integer weightGrams 1..30000; no extra fields.');
  }
  return { currency: 'IDR', amount: rates[input.zone] * Math.ceil(input.weightGrams / 1000),
    billableKg: Math.ceil(input.weightGrams / 1000), rateVersion: '2026-01' };
}

export function createApp({ apiKey, rateLimit = 60, windowMs = 60000,
  now = Date.now, logger = line => console.log(JSON.stringify(line)) } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 32 || apiKey.startsWith('replace-')) {
    throw new Error('API_KEY must contain at least 32 characters and must not be the example value.');
  }
  const expected = hash(`Bearer ${apiKey}`);
  // One bounded, process-local bucket: deliberately a demo load-shedding limit.
  let windowStart = now();
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const started = now();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () => logger({ requestId, method: req.method,
      status: res.statusCode, durationMs: now() - started }));
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { status: 'ok' });
    if (now() - windowStart >= windowMs) { windowStart = now(); requests = 0; }
    if (++requests > rateLimit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowMs - (now() - windowStart)) / 1000))));
      return send(429, { error: 'rate_limit_exceeded', requestId });
    }
    if (!timingSafeEqual(hash(req.headers.authorization ?? ''), expected)) {
      return send(401, { error: 'unauthorized', requestId });
    }
    if (req.url !== '/v1/quotes') return send(404, { error: 'not_found', requestId });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(405, { error: 'method_not_allowed', requestId });
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(415, { error: 'use_application_json', requestId });
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) {
          res.setHeader('Connection', 'close');
          send(413, { error: 'body_too_large', requestId });
          return;
        }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, { error: 'invalid_json', requestId }); }
      let quote;
      try { quote = calculateQuote(input); }
      catch (error) { return send(422, { error: error.message, requestId }); }
      return send(200, quote);
    } catch {
      if (!res.headersSent && !res.destroyed) send(400, { error: 'request_aborted', requestId });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxHeadersCount = 30;
  return server;
}
