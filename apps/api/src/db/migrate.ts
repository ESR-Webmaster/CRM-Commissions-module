import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'path';
import pino from 'pino';

const logger = pino({ name: 'migrate' });

const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('DATABASE_URL environment variable is required');
}

const migrationsFolder = path.resolve(__dirname, '../../../../db/migrations');

async function main() {
  const client = postgres(url as string, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  logger.info('Migrations applied successfully');
  await client.end();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
