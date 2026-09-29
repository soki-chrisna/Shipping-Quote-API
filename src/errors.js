export const publicErrors = Object.freeze({
  invalid_json: [400, 'The request could not be processed.'],
  request_aborted: [400, 'The request could not be processed.'],
  unauthorized: [401, 'Authentication is required.'],
  not_found: [404, 'The requested resource was not found.'],
  method_not_allowed: [405, 'This request method is not supported.'],
  body_too_large: [413, 'The request is too large.'],
  use_application_json: [415, 'The request format is not supported.'],
  invalid_request: [422, 'The request is invalid.'],
  rate_limit_exceeded: [429, 'Too many requests. Please try again later.'],
  internal_error: [500, 'Something went wrong. Please try again later.']
});

// Carries internal context only. HTTP responses are built from publicErrors.
export class LayerError extends Error {
  constructor(layer, code, message, cause) {
    super(message, { cause });
    this.name = 'LayerError';
    this.layer = layer;
    this.code = code;
  }
}

export class QuoteValidationError extends LayerError {
  constructor() {
    super('validation', 'invalid_request',
      'Use zone local/domestic and integer weightGrams 1..30000; no extra fields.');
    this.name = 'QuoteValidationError';
  }
}

export function errorDetails(error, depth = 0) {
  if (!(error instanceof Error)) return { name: 'NonError', message: String(error) };
  const details = { name: error.name, message: error.message, stack: error.stack };
  if (error.code) details.code = error.code;
  if (error.cause !== undefined && depth < 5) details.cause = errorDetails(error.cause, depth + 1);
  return details;
}

export function createSafeLogger(logger, apiKey) {
  return event => {
    // Redact the configured credential even when embedded in exception details.
    const serialized = JSON.stringify(event, (key, value) =>
      typeof value === 'string' ? value.split(apiKey).join('[REDACTED]') : value);
    try {
      logger(JSON.parse(serialized));
    } catch {
      // A broken logging sink must neither crash requests nor lose their evidence.
      console.error(serialized);
    }
  };
}
