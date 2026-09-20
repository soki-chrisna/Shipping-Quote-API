const MIN_WEIGHT_GRAMS = 1;
const MAX_WEIGHT_GRAMS = 30000;
const GRAMS_PER_KILOGRAM = 1000;
const RATE_VERSION = '2026-01';

const SHIPPING_RATES = Object.freeze({
  local: 10000,
  domestic: 25000
});

function isValidQuoteInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }

  const fields = Object.keys(input).sort().join(',');
  const hasExpectedFields = fields === 'weightGrams,zone';
  const hasValidZone = typeof input.zone === 'string'
    && Object.hasOwn(SHIPPING_RATES, input.zone);
  const hasValidWeight = Number.isInteger(input.weightGrams)
    && input.weightGrams >= MIN_WEIGHT_GRAMS
    && input.weightGrams <= MAX_WEIGHT_GRAMS;

  return hasExpectedFields && hasValidZone && hasValidWeight;
}

export function calculateQuote(input) {
  if (!isValidQuoteInput(input)) {
    throw new Error('Use zone local/domestic and integer weightGrams 1..30000; no extra fields.');
  }

  const billableKg = Math.ceil(input.weightGrams / GRAMS_PER_KILOGRAM);

  return {
    currency: 'IDR',
    amount: SHIPPING_RATES[input.zone] * billableKg,
    billableKg,
    rateVersion: RATE_VERSION
  };
}
