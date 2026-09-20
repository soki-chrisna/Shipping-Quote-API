const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000';
const REQUEST_TIMEOUT_MS = 3000;
const CART_AMOUNT = 200000;

async function requestShippingQuote() {
  const apiBaseUrl = process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const response = await fetch(`${apiBaseUrl}/v1/quotes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      zone: 'domestic',
      weightGrams: 1500
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Shipping API returned HTTP ${response.status}`);
  }

  return response.json();
}

function validateQuote(quote) {
  const isValid = quote.currency === 'IDR'
    && Number.isSafeInteger(quote.amount)
    && quote.amount > 0;

  if (!isValid) {
    throw new Error('Invalid shipping response');
  }
}

try {
  const quote = await requestShippingQuote();
  validateQuote(quote);

  console.log({
    cartAmount: CART_AMOUNT,
    shipping: quote.amount,
    total: CART_AMOUNT + quote.amount
  });
} catch (error) {
  console.error(`Checkout paused: ${error.message}. Ask the customer to retry.`);
  process.exitCode = 1;
}
