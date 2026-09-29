import { publicErrors } from './errors.js';

const requestIdHeader = {
  description: 'Request identifier, also included in error response bodies.',
  schema: { type: 'string', format: 'uuid' }
};

function jsonResponse(description, schema, example, headers = {}) {
  return {
    description,
    headers: { 'X-Request-Id': requestIdHeader, ...headers },
    content: { 'application/json': { schema, example } }
  };
}

function errorResponse(description, error, headers) {
  return jsonResponse(description, { $ref: '#/components/schemas/Error' }, {
    error,
    message: publicErrors[error][1],
    requestId: '7d9104fd-3458-41d0-b035-bfb34e854a9d'
  }, headers);
}

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Shipping Quote API',
    version: '0.1.0',
    description: 'Sample shipping price estimates in IDR; no shipments are booked. '
      + 'Quote requests are checked in this order: rate limit, authentication, path, method, '
      + 'content type, JSON parsing, input validation. Unknown paths return 404 after authentication. '
      + 'All responses include X-Request-Id, Cache-Control: no-store, and X-Content-Type-Options: nosniff.'
  },
  servers: [{ url: '/', description: 'Current API origin' }],
  security: [{ bearerAuth: [] }],
  tags: [{ name: 'Health' }, { name: 'Quotes' }],
  paths: {
    '/healthz': {
      get: {
        operationId: 'getHealth',
        tags: ['Health'],
        summary: 'Check process liveness',
        description: 'Public and exempt from rate limiting. Does not check external dependencies.',
        security: [],
        responses: {
          200: jsonResponse('The process is running.', {
            type: 'object', required: ['status'], additionalProperties: false,
            properties: { status: { type: 'string', enum: ['ok'] } }
          }, { status: 'ok' })
        }
      }
    },
    '/v1/quotes': {
      post: {
        operationId: 'createQuote',
        tags: ['Quotes'],
        summary: 'Calculate a shipping quote',
        description: 'Weight rounds up to whole kilograms. Local costs IDR 10,000/kg; domestic '
          + 'costs IDR 25,000/kg. The JSON body is limited to 4,096 bytes. The default quota is '
          + '60 requests per 60-second window per process, shared by all callers including invalid '
          + 'and unauthorized requests. Health and documentation GET requests are exempt.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/QuoteRequest' },
              example: { zone: 'domestic', weightGrams: 1500 }
            }
          }
        },
        responses: {
          200: jsonResponse('Shipping estimate.', { $ref: '#/components/schemas/Quote' }, {
            currency: 'IDR', amount: 50000, billableKg: 2, rateVersion: '2026-01'
          }),
          400: errorResponse('Malformed JSON (invalid_json) or incomplete body (request_aborted).', 'invalid_json'),
          401: errorResponse('Missing or incorrect bearer API key.', 'unauthorized'),
          405: errorResponse('The quote route only accepts POST.', 'method_not_allowed', {
            Allow: { schema: { type: 'string', enum: ['POST'] } }
          }),
          413: errorResponse('Body exceeds 4,096 bytes; connection is closed.', 'body_too_large', {
            Connection: { schema: { type: 'string', enum: ['close'] } }
          }),
          415: errorResponse('Content-Type must be application/json (parameters are allowed).', 'use_application_json'),
          422: errorResponse('Input does not match the request schema.',
            'invalid_request'),
          500: errorResponse('Unexpected server failure.', 'internal_error'),
          429: errorResponse('Shared process quota exceeded.', 'rate_limit_exceeded', {
            'Retry-After': {
              description: 'Seconds until the current rate limit window ends.',
              schema: { type: 'integer', minimum: 1 }
            }
          })
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http', scheme: 'bearer',
        description: 'Enter the configured API_KEY without the Bearer prefix. This is a shared API key, not a JWT.'
      }
    },
    schemas: {
      QuoteRequest: {
        type: 'object', additionalProperties: false, required: ['zone', 'weightGrams'],
        properties: {
          zone: { type: 'string', enum: ['local', 'domestic'] },
          weightGrams: { type: 'integer', minimum: 1, maximum: 30000 }
        }
      },
      Quote: {
        type: 'object', additionalProperties: false,
        required: ['currency', 'amount', 'billableKg', 'rateVersion'],
        properties: {
          currency: { type: 'string', enum: ['IDR'] },
          amount: { type: 'integer', minimum: 10000, maximum: 750000, description: 'Whole Indonesian rupiah.' },
          billableKg: { type: 'integer', minimum: 1, maximum: 30 },
          rateVersion: { type: 'string', example: '2026-01' }
        }
      },
      Error: {
        type: 'object', additionalProperties: false, required: ['error', 'message', 'requestId'],
        properties: {
          error: { type: 'string' },
          message: { type: 'string', description: 'General client-safe message; never exception details.' },
          requestId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }
};

// Pin browser assets so documentation does not silently change between releases.
export const swaggerHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shipping Quote API — Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.33.0/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <noscript>Enable JavaScript to use Swagger UI. The specification is available at /openapi.json.</noscript>
  <script src="https://unpkg.com/swagger-ui-dist@5.33.0/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      persistAuthorization: false,
      validatorUrl: null
    });
  </script>
</body>
</html>`;
