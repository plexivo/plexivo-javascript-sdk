// One-time setup, from your own machine: creates the example tables and
// their row-level security policies with the project's SECRET key.
//
//   node --env-file=examples/node/.env examples/node/setup.ts
//
// The secret key runs as the database owner and bypasses row-level
// security. It belongs on a server or your laptop — never in an app.
import { readFile } from 'node:fs/promises';
import { createClient } from '@plexivo/client';
import { projectUrl } from './config.ts';

const secretKey = process.env.PLEXIVO_SECRET_KEY;
if (!secretKey) {
  console.error('Set PLEXIVO_SECRET_KEY in examples/node/.env for setup (or run examples/schema.sql in psql).');
  process.exit(2);
}

const server = createClient(projectUrl, secretKey, { persistSession: false });

// schema.sql, one statement at a time (comments dropped).
const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(/;\s*$/m)
  .map((statement) => statement.trim())
  .filter(Boolean);

// All of them in one transaction: every statement commits, or none does.
await server.sqlTransaction(statements);
console.log(`Applied ${statements.length} statements.`);
console.log('Tables in the Data API:', (await server.migrator.tables()).join(', '));
console.log('Next: switch Realtime on for todos and messages in the console (Realtime tab).');
