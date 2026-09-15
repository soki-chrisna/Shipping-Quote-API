# Architecture and boundaries

## Why this scope

Shipping prices are deterministic and require no stored customer data. The API can be replicated without
sharing order state. The checkout example acts as a consumer and deliberately pauses on errors.
Money is an integer in IDR. Input weight is grams, rounded up for billing.
No database is necessary for this use case; persisting orders would be a separate service/change.

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
- Actions and base images are version-tagged starter dependencies, not immutable supply-chain pins.

## Scaling exercise

Keep quote computation stateless behind a load balancer; introduce shared rate limiting and per-consumer identity.
Measure latency/throughput/error rates before picking replica counts. Centralize logs and define an availability target.
Move to blue/green or rolling deployment when the downtime target requires it. These are design directions, not shipped features.
