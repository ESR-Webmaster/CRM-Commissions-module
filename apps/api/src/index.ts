import http from 'node:http';
import { app } from './app';
import { db } from './db/index';
import { rootLogger } from './middleware/requestLogger';

const port = Number(process.env['PORT'] ?? '3001');
const server = http.createServer(app);

server.listen(port, () => {
  rootLogger.info({ port }, 'API server started');
});

function shutdown(reason: string) {
  rootLogger.info({ event: 'shutdown', reason }, 'Graceful shutdown initiated');

  server.close(async () => {
    try {
      // Close Drizzle's underlying postgres connection pool
      const client = (db as unknown as { _client?: { end?: () => Promise<void> } })._client;
      if (client?.end) await client.end();
    } catch {
      // pool already closed
    }
    rootLogger.info({ event: 'shutdown', reason }, 'Shutdown complete');
    process.exit(0);
  });

  // Force exit if draining takes longer than 30 seconds
  setTimeout(() => {
    rootLogger.error({ event: 'shutdown', reason }, 'Drain timeout — forcing exit');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
