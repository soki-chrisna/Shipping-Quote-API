import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { calculateQuote } from './quote.js';

export { calculateQuote } from './quote.js';

const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 4096;
const MIN_API_KEY_LENGTH = 32;

class RequestBodyTooLargeError extends Error {}

function hash(value) {
  return createHash('sha256').update(value).digest();
}

function validateApiKey(apiKey) {
  const isInvalid = typeof apiKey !== 'string'
    || apiKey.length < MIN_API_KEY_LENGTH
    || apiKey.startsWith('replace-');

  if (isInvalid) {
    throw new Error('API_KEY must contain at least 32 characters and must not be the example value.');
  }
}

function createRateLimiter({ limit, windowMs, now }) {
  let windowStartedAt = now();
  let requestCount = 0;

  return {
    consume() {
      const elapsedMs = now() - windowStartedAt;

      if (elapsedMs >= windowMs) {
        windowStartedAt = now();
        requestCount = 0;
      }

      requestCount += 1;

      if (requestCount <= limit) {
        return { allowed: true };
      }

      const remainingMs = windowMs - (now() - windowStartedAt);
      const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));

      return { allowed: false, retryAfterSeconds };
    }
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': CONTENT_TYPE_JSON });
  response.end(JSON.stringify(body));
}

function isJsonRequest(request) {
  const contentType = request.headers['content-type'];
  return contentType?.split(';')[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }

    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function addResponseHeaders(response, requestId) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
}

function addRequestLog({ request, response, requestId, startedAt, now, logger }) {
  response.on('finish', () => {
    logger({
      requestId,
      method: request.method,
      status: response.statusCode,
      durationMs: now() - startedAt
    });
  });
}

function isAuthorized(request, expectedAuthorizationHash) {
  const suppliedAuthorizationHash = hash(request.headers.authorization ?? '');
  return timingSafeEqual(suppliedAuthorizationHash, expectedAuthorizationHash);
}

function createRequestHandler({ apiKey, rateLimit, windowMs, now, logger }) {
  const expectedAuthorizationHash = hash(`Bearer ${apiKey}`);
  const rateLimiter = createRateLimiter({ limit: rateLimit, windowMs, now });

  return async function handleRequest(request, response) {
    const requestId = randomUUID();
    const startedAt = now();

    addResponseHeaders(response, requestId);
    addRequestLog({ request, response, requestId, startedAt, now, logger });

    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    const rateLimitResult = rateLimiter.consume();

    if (!rateLimitResult.allowed) {
      response.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
      sendJson(response, 429, { error: 'rate_limit_exceeded', requestId });
      return;
    }

    if (!isAuthorized(request, expectedAuthorizationHash)) {
      sendJson(response, 401, { error: 'unauthorized', requestId });
      return;
    }

    if (request.url !== '/v1/quotes') {
      sendJson(response, 404, { error: 'not_found', requestId });
      return;
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { error: 'method_not_allowed', requestId });
      return;
    }

    if (!isJsonRequest(request)) {
      sendJson(response, 415, { error: 'use_application_json', requestId });
      return;
    }

    let input;

    try {
      input = await readJsonBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response.setHeader('Connection', 'close');
        sendJson(response, 413, { error: 'body_too_large', requestId });
        return;
      }

      if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: 'invalid_json', requestId });
        return;
      }

      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 400, { error: 'request_aborted', requestId });
      }

      return;
    }

    try {
      const quote = calculateQuote(input);
      sendJson(response, 200, quote);
    } catch (error) {
      sendJson(response, 422, { error: error.message, requestId });
    }
  };
}

export function createApp({
  apiKey,
  rateLimit = 60,
  windowMs = 60000,
  now = Date.now,
  logger = event => console.log(JSON.stringify(event))
} = {}) {
  validateApiKey(apiKey);

  const requestHandler = createRequestHandler({
    apiKey,
    rateLimit,
    windowMs,
    now,
    logger
  });

  const server = http.createServer(requestHandler);

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxHeadersCount = 30;

  return server;
}
