import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { calculateQuote } from './quote.js';
import { openApiDocument, swaggerHtml } from './openapi.js';
import { LayerError, QuoteValidationError, publicErrors, errorDetails, createSafeLogger } from './errors.js';

export { calculateQuote } from './quote.js';

const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 4096;
const MIN_API_KEY_LENGTH = 32;

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
  const serialized = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': CONTENT_TYPE_JSON });
  response.end(serialized);
}

function isJsonRequest(request) {
  const contentType = request.headers['content-type'];
  return contentType?.split(';')[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        throw new LayerError('body', 'body_too_large', `Request body exceeded ${MAX_BODY_BYTES} bytes.`);
      }

      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof LayerError) throw error;
    const code = request.aborted || error.code === 'ECONNRESET' ? 'request_aborted' : 'internal_error';
    throw new LayerError('body', code, 'Failed to read request body.', error);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // JSON.parse messages can contain body excerpts. Keep type and call frames,
    // but remove the excerpt before retaining the cause in internal logs.
    const cause = new SyntaxError('Malformed JSON; request content omitted.');
    cause.stack = `${cause.name}: ${cause.message}\n${error.stack.split('\n').filter(line => /^\s+at /.test(line)).join('\n')}`;
    throw new LayerError('parsing', 'invalid_json', 'Failed to parse request JSON.', cause);
  }
}

function addResponseHeaders(response, requestId) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
}

function addRequestLog({ request, response, requestId, startedAt, now, logger }) {
  response.on('finish', () => {
    logger({
      event: 'request_completed',
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

function createRequestHandler({ apiKey, rateLimit, windowMs, now, logger, quoteCalculator }) {
  const expectedAuthorizationHash = hash(`Bearer ${apiKey}`);
  const rateLimiter = createRateLimiter({ limit: rateLimit, windowMs, now });

  return async function handleRequest(request, response) {
    const requestId = randomUUID();
    // Snapshot the connection address before a disconnect can clear it.
    const caller = {
      id: null,
      authenticated: false,
      ip: request.socket.remoteAddress ?? null
    };
    const requestLogger = event => logger({ ...event, requestId, caller: { ...caller } });
    try {
      // Identify callers even for public routes and rate-limit rejections.
      // Access checks below retain their existing order.
      caller.authenticated = isAuthorized(request, expectedAuthorizationHash);
      caller.id = caller.authenticated ? 'shared-api-client' : null;
      const startedAt = now();

      addResponseHeaders(response, requestId);
      addRequestLog({ request, response, requestId, startedAt, now, logger: requestLogger });

      if (request.method === 'GET' && request.url === '/healthz') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && (request.url === '/docs' || request.url === '/docs/')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(swaggerHtml);
        return;
      }

      if (request.method === 'GET' && request.url === '/openapi.json') {
        sendJson(response, 200, openApiDocument);
        return;
      }

      const rateLimitResult = rateLimiter.consume();

      if (!rateLimitResult.allowed) {
        response.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
        throw new LayerError('rate_limit', 'rate_limit_exceeded', 'Process request quota exceeded.');
      }

      if (!caller.authenticated) {
        throw new LayerError('authentication', 'unauthorized', 'Bearer credentials missing or incorrect.');
      }

      if (request.url !== '/v1/quotes') {
        throw new LayerError('routing', 'not_found', 'No matching application route.');
      }

      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        throw new LayerError('routing', 'method_not_allowed', 'Quote route requires POST.');
      }

      if (!isJsonRequest(request)) {
        throw new LayerError('content_type', 'use_application_json', 'Expected application/json media type.');
      }

      const input = await readJsonBody(request);
      let quote;
      try {
        quote = await quoteCalculator(input);
      } catch (error) {
        if (error instanceof QuoteValidationError) throw error;
        throw new LayerError('quote_service', 'internal_error', 'Quote calculation failed.', error);
      }
      sendJson(response, 200, quote);
    } catch (error) {
      const failure = error instanceof LayerError ? error
        : new LayerError('http', 'internal_error', 'Unhandled request failure.', error);
      const code = Object.hasOwn(publicErrors, failure.code) ? failure.code : 'internal_error';
      const [status, message] = publicErrors[code];
      // Log once at the boundary, retaining the originating layer and cause.
      requestLogger({
        event: 'request_failed', timestamp: new Date().toISOString(),
        level: status >= 500 ? 'error' : 'warn', requestId,
        method: request.method, layer: failure.layer, code, status,
        error: errorDetails(failure)
      });
      if (!response.headersSent && !response.destroyed) {
        addResponseHeaders(response, requestId);
        if (status === 413) response.setHeader('Connection', 'close');
        sendJson(response, status, { error: code, message, requestId });
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  };
}

export function createApp({
  apiKey,
  rateLimit = 60,
  windowMs = 60000,
  now = Date.now,
  logger = event => console.log(JSON.stringify(event)),
  quoteCalculator = calculateQuote
} = {}) {
  validateApiKey(apiKey);

  const requestHandler = createRequestHandler({
    apiKey,
    rateLimit,
    windowMs,
    now,
    logger: createSafeLogger(logger, apiKey),
    quoteCalculator
  });

  const server = http.createServer(requestHandler);

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxHeadersCount = 30;

  return server;
}
