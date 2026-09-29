# Architecture and boundaries

## Why this scope

Shipping prices are deterministic and require no stored customer data. The API can be replicated without
sharing order state. The checkout example acts as a consumer and deliberately pauses on errors.
Money is an integer in IDR. Input weight is grams, rounded up for billing.
No database is necessary for this use case; persisting orders would be a separate service/change.

## Module responsibilities

| Module | Responsibility |
|---|---|
| [`src/server.js`](../src/server.js) | Read process configuration, listen, and shut down on signals. |
| [`src/app.js`](../src/app.js) | Enforce HTTP checks, read and parse bounded input, invoke the calculator, and report failures. |
| [`src/quote.js`](../src/quote.js) | Validate quote fields and calculate integer IDR prices without HTTP or logging dependencies. |
| [`src/errors.js`](../src/errors.js) | Define internal error context, client-safe responses, cause serialization, and credential redaction. |
| [`src/openapi.js`](../src/openapi.js) | Describe the API contract and serve the Swagger UI markup. |

`createApp()` accepts a clock, logger, and quote calculator so tests can control time,
capture events, and simulate service failures. Each call owns its rate limiter;
creating another server does not share counters with the first one.

## Request lifecycle

1. Generate a request ID and capture the direct connection IP. Check bearer credentials
   for log attribution, including requests to public endpoints.
2. Register response headers and completion logging.
3. Serve public GET requests for `/healthz`, `/docs`, `/docs/`, and `/openapi.json`.
4. Consume the shared quota, then enforce authentication, path, method, and content type,
   in that order. A quota rejection takes precedence over an authentication rejection.
5. Read at most 4,096 bytes, parse JSON, validate the exact quote fields, and calculate
   the price. Weight rounds up to whole kilograms before multiplying by the zone rate.
6. Send the quote or pass the failure to the single HTTP error boundary.

The limiter uses a fixed window starting when the app is created. The next request
after the window expires resets the counter. Failed authentication and other business
request rejections consume quota; public GET routes do not. `Retry-After` rounds the
remaining window up to seconds, with a minimum of one.

## Error boundaries and logging

`LayerError` carries an internal layer, public error code, diagnostic message, and
optional cause. Body reading, JSON parsing, and calculator invocation add context at
their own boundaries. `QuoteValidationError` retains its `validation` layer; other
calculator failures become `quote_service` errors. Unexpected HTTP failures, including
response serialization, become `http` errors.

`handleRequestFailure()` emits one `request_failed` event and selects the client-safe
`status` and `message` from `publicErrors`. Unrecognized codes fall back to
`internal_error`. Exception messages, stacks, and causes are never used as public
response messages. If headers have already been sent, the connection is destroyed
instead of attempting a second response; disconnected requests can still be logged.

The completion event is emitted only when the response finishes. Both event types
include a request ID and a snapshot of the caller context. The shared credential
identifies `shared-api-client`, not an individual user. The IP is the direct socket
address; forwarding and user identity headers are not trusted.

Internal logs retain error stacks and up to five nested causes. Parser error messages
are sanitized because Node can include submitted JSON in them. The safe logger redacts
the configured API key from string values, including nested causes, before sending an
event to the configured sink. If that sink throws, the same redacted event goes to
standard error. Other secrets must not be put into service exception messages.

See [the API reference](API.md) for response contracts and log fields, and
[the deployment runbook](DEPLOYMENT.md) for deployment and recovery concepts.

## Code and documentation conventions

- Use names that express purpose and units, such as `receivedBytes` and
  `RATE_IDR_PER_KILOGRAM_BY_ZONE`.
- Use named object properties for shared records, such as an error's `status` and
  `message`, so consumers do not need to memorize array positions.
- Keep HTTP orchestration readable by giving parsing, service invocation, and failure
  handling explicit functions. Keep small, direct checks inline when a helper adds no meaning.
- Reserve comments for non-obvious reasons or constraints, such as equal-length hashes
  for timing-safe comparison and removing body excerpts from parser errors.
- Keep cross-module concepts and tradeoffs here, public contracts in [API.md](API.md),
  and operational procedures in [DEPLOYMENT.md](DEPLOYMENT.md). Update the relevant
  document and contract tests when changing behavior.

## Security implemented

- Startup rejects missing, short, or placeholder API keys. `.env` is ignored by Git and excluded from image.
- Hashed token comparison uses constant-length buffers and a timing-safe comparison.
- Explicit input allowlist, bounded body, timeouts, method checks, no client-supplied price.
- A bounded process-local request bucket limits all business requests, including failed auth.
- Responses are not cached. Logs contain request ID, method, status, latency; no request body or token.
- Container uses non-root and deployment adds read-only filesystem, dropped capabilities, resource/log limits.

## Limits and next steps

- Shared API key gives machine authentication, no users, roles, tenants, expiry or per-client revocation.
  Use separate hashed keys per consumer or an identity provider when requirements justify them.
- HTTP local development must be behind a TLS reverse proxy for remote use. The deploy script binds to loopback.
- Rate limiter is per process and shared across callers. One noisy client can exhaust it. Multiple replicas
  multiply the quota. Put per-client limits at an API gateway or atomic shared store before relying on a global quota.
- Health endpoint reports process liveness only; no database/dependencies exist. Add readiness checks when they do.
- Request body and timeout limits reduce abuse; an edge proxy still needs connection/body limits and abuse controls.
- No distributed tracing, external alerting, autoscaling, persistent metrics, or vulnerability scan is included.
- Deployment is a single-server replacement with brief downtime. Rollback keeps the prior container's environment;
  rotating an exposed key also requires updating/redeploying any rollback version.
- Public GHCR images contain code. Keep confidential images private and provision read-only registry access on the VPS.
- Docker access is powerful host access. Use a dedicated VPS and a dedicated deployment SSH key.
- Actions and base images are version-tagged dependencies, not immutable supply-chain pins.
