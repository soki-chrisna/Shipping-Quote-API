// A separate consumer process: shipping failure must not silently become free shipping.
const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
try {
  const response = await fetch(`${base}/v1/quotes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: 'domestic', weightGrams: 1500 }),
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`Shipping API returned HTTP ${response.status}`);
  const quote = await response.json();
  if (quote.currency !== 'IDR' || !Number.isSafeInteger(quote.amount) || quote.amount <= 0) {
    throw new Error('Invalid shipping response');
  }
  console.log({ cartAmount: 200000, shipping: quote.amount, total: 200000 + quote.amount });
} catch (error) {
  console.error(`Checkout paused: ${error.message}. Ask the customer to retry.`);
  process.exitCode = 1;
}
