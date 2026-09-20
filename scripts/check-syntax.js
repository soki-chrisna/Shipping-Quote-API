import { spawnSync } from 'node:child_process';

const files = [
  'src/app.js',
  'src/healthcheck.js',
  'src/quote.js',
  'src/server.js',
  'examples/checkout-client.js',
  'scripts/check-syntax.js',
  'scripts/verify-quote-response.js',
  'test/api.test.js'
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
