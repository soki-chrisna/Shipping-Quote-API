const port = process.env.PORT ?? 3000;
const healthUrl = `http://127.0.0.1:${port}/healthz`;

try {
  const response = await fetch(healthUrl);
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
