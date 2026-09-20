import { createApp } from './app.js';

const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 10000;

function readPort(value) {
  const port = Number(value ?? DEFAULT_PORT);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PORT');
  }

  return port;
}

const port = readPort(process.env.PORT);
const server = createApp({ apiKey: process.env.API_KEY });

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', port }));
});

function shutDown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, shutDown);
}
