/**
 * Generates a signed JWT for local development.
 *
 * Usage:
 *   pnpm tsx scripts/gen-dev-token.ts [role]
 *
 * role defaults to 'admin'. Pass 'rep' for a read-only token.
 *
 * Requires JWT_SIGNING_KEY and DATABASE_URL in environment (load your .env first).
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { orgs } from '../apps/api/src/db/schema/orgs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://commissions:commissions@localhost:5433/commissions';
const JWT_SIGNING_KEY = process.env['JWT_SIGNING_KEY'];
const role = (process.argv[2] === 'rep' ? 'rep' : 'admin') as 'admin' | 'rep';

async function main() {
  if (!JWT_SIGNING_KEY) {
    process.stderr.write(
      'ERROR: JWT_SIGNING_KEY env var is not set.\n' +
      'Load your .env file first:\n' +
      '  export $(grep -v "^#" .env | xargs) && pnpm tsx scripts/gen-dev-token.ts\n',
    );
    process.exit(1);
  }

  const sql = postgres(DATABASE_URL);
  const db = drizzle(sql);

  // Get the first org or create one for local dev
  let [org] = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).limit(1);

  if (!org) {
    const [created] = await db
      .insert(orgs)
      .values({ id: randomUUID(), name: 'Dev Org', settings: { require_event_approval: false } })
      .returning({ id: orgs.id, name: orgs.name });
    org = created;
  }

  if (!org) {
    process.stderr.write('ERROR: Could not find or create an org.\n');
    await sql.end();
    process.exit(1);
  }

  const userId = randomUUID();

  const token = jwt.sign(
    { org_id: org.id, user_id: userId, role },
    JWT_SIGNING_KEY,
    { algorithm: 'HS256', expiresIn: '24h' },
  );

  await sql.end();

  process.stdout.write(`
Org:  ${org.name} (${org.id})
User: ${userId}
Role: ${role}

Bearer token (valid 24 h):
${token}
`);
}

void main();
