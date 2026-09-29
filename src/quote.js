import { QuoteValidationError } from './errors.js';

const MIN_WEIGHT_GRAMS = 1;
const MAX_WEIGHT_GRAMS = 30000;
const GRAMS_PER_KILOGRAM = 1000;
const RATE_VERSION = '2026-01';

const RATE_IDR_PER_KILOGRAM_BY_ZONE = Object.freeze({
  local: 10000,
  domestic: 25000
});

function isValidQuoteInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }

  const inputFields = Object.keys(input);
  const hasExpectedFields = inputFields.length === 2
    && inputFields.includes('zone')
    && inputFields.includes('weightGrams');
  const hasValidZone = typeof input.zone === 'string'
    && Object.hasOwn(RATE_IDR_PER_KILOGRAM_BY_ZONE, input.zone);
  const hasValidWeight = Number.isInteger(input.weightGrams)
    && input.weightGrams >= MIN_WEIGHT_GRAMS
    && input.weightGrams <= MAX_WEIGHT_GRAMS;

  return hasExpectedFields && hasValidZone && hasValidWeight;
}

export function calculateQuote(input) {
  if (!isValidQuoteInput(input)) {
    throw new QuoteValidationError();
  }

  const billableKg = Math.ceil(input.weightGrams / GRAMS_PER_KILOGRAM);

  return {
    currency: 'IDR',
    amount: RATE_IDR_PER_KILOGRAM_BY_ZONE[input.zone] * billableKg,
    billableKg,
    rateVersion: RATE_VERSION
  };
}
