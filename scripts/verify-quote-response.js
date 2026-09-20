let responseBody = '';

for await (const chunk of process.stdin) {
  responseBody += chunk;
}

const quote = JSON.parse(responseBody);

if (quote.amount !== 50000) {
  console.error(`Unexpected quote amount: ${quote.amount}`);
  process.exitCode = 1;
}
