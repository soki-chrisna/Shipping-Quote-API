# Shipping Quote API Reference

This document describes the HTTP API implemented by [`src/app.js`](../src/app.js) and the quote rules in [`src/quote.js`](../src/quote.js). It is intended for application developers integrating with the service.

The service is stateless and returns a shipping price estimate from a shipping zone and package weight. The configured prices are sample application data; they are not live carrier quotes or a shipping booking.

## At a glance

Interactive documentation is available at [`/docs`](http://localhost:3000/docs), with the
machine-readable OpenAPI contract at [`/openapi.json`](http://localhost:3000/openapi.json).
Both support public GET requests without consuming the business rate limit. In Swagger UI,
click **Authorize** and enter the configured API key without the `Bearer ` prefix.
The UI uses pinned CDN assets and needs browser internet access; the JSON contract does not.
See [`src/openapi.js`](../src/openapi.js) to maintain the specification alongside API changes.

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | None | Process liveness check |
| `POST` | `/v1/quotes` | Bearer API key | Calculate a shipping quote |

The API uses JSON for request and response bodies. It does not persist quotes, create shipments, or accept client-provided prices.

## Base URL and transport

For local development, the default server listens on `http://127.0.0.1:3000`. The port can be changed with the `PORT` environment variable. Use your deployed API origin as the base URL in other environments.

The Node.js server itself speaks HTTP. Remote deployments should put it behind a TLS-terminating reverse proxy; send credentials only over HTTPS outside a trusted local development environment.

## Authentication

`POST /v1/quotes` uses one shared bearer token:

```http
Authorization: Bearer <API_KEY>
```

The server's `API_KEY` must be set when the process starts, contain at least 32 characters, and not start with `replace-`. Missing or incorrect credentials produce `401 Unauthorized`.

`GET /healthz` does not require authentication. The service currently has no user accounts, scopes, tenants, per-client keys, or key expiry. Treat the API key as a secret: store it in a secret manager or environment configuration and do not place it in source control or logs.

## Health check

### `GET /healthz`

Returns a liveness response when the server can handle requests. It does not require a bearer token and is exempt from the application rate limit. It does not check external dependencies or indicate that a quote request will pass authentication or validation.

#### Success: `200 OK`

```json
{"status":"ok"}
```

## Create a quote

### `POST /v1/quotes`

Calculates the sample shipping price for a zone and package weight.

#### Request headers

```http
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

The media type comparison is case-insensitive and permits parameters such as `application/json; charset=utf-8`.

#### Request body

The body must be a JSON object with exactly these two properties. Additional properties are rejected.

| Property | Type | Required | Constraints |
|---|---|---:|---|
| `zone` | string | Yes | `local` or `domestic` |
| `weightGrams` | integer | Yes | From `1` through `30000`, inclusive |

Example:

```json
{
  "zone": "domestic",
  "weightGrams": 1500
}
```

The complete request body is limited to 4,096 bytes. Fractional values, numeric strings, unsupported zones, missing properties, and extra properties are invalid.

#### Success: `200 OK`

```json
{
  "currency": "IDR",
  "amount": 50000,
  "billableKg": 2,
  "rateVersion": "2026-01"
}
```

| Property | Type | Description |
|---|---|---|
| `currency` | string | Always `IDR` for the current rate set. |
| `amount` | integer | Total quote amount in whole Indonesian rupiah. |
| `billableKg` | integer | Package weight rounded up to the next whole kilogram. |
| `rateVersion` | string | Version identifier for the rate set used to calculate the quote. |

The calculation is `rate per kilogram × billable kilograms`, where `billableKg = ceil(weightGrams / 1000)`.

| Zone | Sample rate |
|---|---:|
| `local` | IDR 10,000 per billable kg |
| `domestic` | IDR 25,000 per billable kg |

For example, a 1,001 gram domestic package is billed as 2 kg and returns `amount: 50000`. A 1 gram local package is billed as 1 kg and returns `amount: 10000`.

#### cURL example

```bash
curl --fail-with-body --request POST 'http://localhost:3000/v1/quotes' \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{"zone":"domestic","weightGrams":1500}'
```

Replace the example token with the configured secret. Use the HTTPS deployment URL for remote requests.

## Error responses

Errors contain a stable `error` code, a general client-safe `message`, and a `requestId` matching the `X-Request-Id` response header. Exception messages, stack traces, and causes are never returned to clients.

| Status | Error | Meaning |
|---:|---|---|
| `400` | `invalid_json` | The body is not valid JSON. |
| `400` | `request_aborted` | The request body could not be read to completion. |
| `401` | `unauthorized` | The bearer token is missing or incorrect. |
| `404` | `not_found` | The requested path is not recognized. |
| `405` | `method_not_allowed` | The path is recognized but the method is not supported. Includes `Allow: POST` for the quote path. |
| `413` | `body_too_large` | The request body exceeds 4,096 bytes. The connection is closed. |
| `415` | `use_application_json` | The request `Content-Type` is not `application/json`. |
| `422` | `invalid_request` | The JSON value does not match the quote input schema or constraints. |
| `429` | `rate_limit_exceeded` | The process-local request quota has been exceeded. Includes `Retry-After`. |
| `500` | `internal_error` | An unexpected server failure occurred. |

Example validation error:

```json
{
  "error": "invalid_request",
  "message": "The request is invalid.",
  "requestId": "7d9104fd-3458-41d0-b035-bfb34e854a9d"
}
```

All requests except public health and documentation GET requests pass through checks in this order: rate limit, authentication, path, method, content type, JSON parsing, and quote validation. If a request violates multiple rules, the first failed check determines the response. In particular, a request to an unknown path without valid credentials is rejected as `401` before it can receive `404`.

## Rate limiting and request limits

By default, the service allows 60 business requests per 60-second window per process. Public health and documentation GET requests are exempt. Both values are configurable when creating the application in code (`rateLimit` and `windowMs`); they are not exposed as server environment variables by the executable entry point.

The quota is shared across all callers in a process and includes unauthorized and otherwise invalid business requests. It is held in process memory, so it resets when the process restarts and is not coordinated across replicas. A `429` response includes `Retry-After` in seconds.

The server also sets a 10-second request timeout, a 10-second header timeout, a 15-second socket timeout, and a maximum of 30 request headers. These are server-side operational limits rather than per-route API parameters.

## Response headers and request tracing

Every response receives these headers:

| Header | Purpose |
|---|---|
| `Content-Type` | `application/json; charset=utf-8` (Swagger UI uses `text/html; charset=utf-8`) |
| `X-Request-Id` | UUID identifying this request; use it when correlating client reports with server logs. |
| `Cache-Control` | `no-store`, to prevent response caching. |
| `X-Content-Type-Options` | `nosniff`. |

Error-specific headers include `Retry-After` on `429` and `Allow: POST` on `405` for `/v1/quotes`.

The server emits a `request_completed` JSON event when a response finishes, containing the request ID, HTTP method, status code, and duration in milliseconds. Each application failure also emits one `request_failed` event with its timestamp, severity, request ID, status, error code, originating layer, and internal error details (name, message, stack, and nested causes up to five levels). Rejections use `warn`; unexpected failures use `error` and HTTP 500. Body reading, JSON parsing, and quote calculation have separate error boundaries; the outer HTTP boundary logs once and selects the public response. Layers are `rate_limit`, `authentication`, `routing`, `content_type`, `body`, `parsing`, `validation`, `quote_service`, and `http`.

To investigate a client report, search the server logs for the returned `requestId`, then inspect `layer` and `error.cause`. Logs are written to standard output by default; deployment log collection must retain them for investigation. If a custom logger throws, the event falls back to standard error. Disconnected clients may have a failure event without a completed response.

Every request-related log, including failures and stderr fallback events, contains `caller: { id, authenticated, ip }`. Valid bearer credentials produce `id: "shared-api-client"` and `authenticated: true`; missing or invalid credentials produce `id: null` and `authenticated: false`. Identity is checked for logging on public routes and rate-limited requests too, without changing which response takes precedence. The shared key identifies an API client, not an individual person; identifying individual users requires per-user authentication. `ip` is the direct connection address, captured before a possible disconnect. Behind a proxy it is the proxy address. Forwarding and user identity headers are not trusted or logged as verified identity.

Request headers, URLs, and bodies are not attached to log events. JSON parser excerpts are removed because they can contain submitted data; parser type and call frames remain. The configured API key is redacted from log strings. Internal service errors retain their details, so service code must avoid including other secrets in exception messages and access to logs should be restricted.

## Client integration notes

- Treat `amount` as an integer number of IDR, not a decimal major-unit value.
- Use `rateVersion` if a consumer needs to record which sample rate set produced a quote.
- Handle non-2xx responses explicitly; a failed quote must not be interpreted as free shipping.
- On `429`, wait for at least the number of seconds in `Retry-After` before retrying. The response does not guarantee that retrying will succeed if other callers continue using the shared quota.
- This endpoint estimates a price only. It does not reserve capacity, validate an address, or book a carrier service.

## Source and configuration

The executable entry point is [`src/server.js`](../src/server.js); it reads `API_KEY` and optional `PORT`, starts the HTTP server, and handles `SIGTERM` and `SIGINT`. The reusable `createApp()` function is exported from [`src/app.js`](../src/app.js) and accepts `apiKey`, `rateLimit`, `windowMs`, `now`, `logger`, and `quoteCalculator` options. The optional calculator defaults to `calculateQuote()` and supports asynchronous implementations. The quote calculation is also exported as `calculateQuote()` from `src/app.js`.

See the [repository README](../README.md) for setup and the [architecture notes](ARCHITECTURE.md) for security decisions and operational limitations.
