export const publicErrors = Object.freeze({
  invalid_json: { status: 400, message: 'The request could not be processed.' },
  request_aborted: { status: 400, message: 'The request could not be processed.' },
  unauthorized: { status: 401, message: 'Authentication is required.' },
  not_found: { status: 404, message: 'The requested resource was not found.' },
  method_not_allowed: { status: 405, message: 'This request method is not supported.' },
  body_too_large: { status: 413, message: 'The request is too large.' },
  use_application_json: { status: 415, message: 'The request format is not supported.' },
  invalid_request: { status: 422, message: 'The request is invalid.' },
  rate_limit_exceeded: { status: 429, message: 'Too many requests. Please try again later.' },
  internal_error: { status: 500, message: 'Something went wrong. Please try again later.' }
});

const MAX_ERROR_CAUSE_DEPTH = 5;

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
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: String(error) };
  }

  const details = { name: error.name, message: error.message, stack: error.stack };

  if (error.code) {
    details.code = error.code;
  }
  if (error.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
    details.cause = errorDetails(error.cause, depth + 1);
  }

  return details;
}

function serializeWithRedactedApiKey(event, apiKey) {
  return JSON.stringify(event, (key, value) =>
    typeof value === 'string' ? value.split(apiKey).join('[REDACTED]') : value);
}

export function createSafeLogger(logger, apiKey) {
  return event => {
    const redactedEventJson = serializeWithRedactedApiKey(event, apiKey);

    try {
      logger(JSON.parse(redactedEventJson));
    } catch {
      // A broken logging sink must neither crash requests nor lose their evidence.
      console.error(redactedEventJson);
    }
  };
}
