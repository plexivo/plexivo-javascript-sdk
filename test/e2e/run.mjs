// The bulletproof end-to-end suite for @plexivo/client against a live
// Plexivo Postgres project: auth, every filter, joins of every kind,
// aggregates, writes, transactions, functions, raw SQL, types, realtime,
// GraphQL, security refusals, expiry and concurrency through the
// connection pooler.
//
//   node test/e2e/run.mjs                  # a fresh project from the harness
//   POOLED=1 node test/e2e/run.mjs         # through the connection pooler
//   API_URL=… PUBLISHABLE_KEY=… SECRET_KEY=… ALLOWED_ORIGIN=… node test/e2e/run.mjs
//   PLEXIVO_SDK_ENTRY=/path/to/node_modules/@plexivo/client node test/e2e/run.mjs
//
// Prints `ok <name>` / `FAIL <name> <details>` per check, a count, and
// `ALL PASSED` when nothing failed.

import {loadSdk, projectUnderTest, waitForApi, redact, note, finish, check, POOLED} from './lib.mjs';
import {SCHEMA} from './schema.mjs';
import {seed} from './seed.mjs';
import auth from './suites/auth.mjs';
import data from './suites/data.mjs';
import relations from './suites/relations.mjs';
import writes from './suites/writes.mjs';
import server from './suites/server.mjs';
import realtime from './suites/realtime.mjs';
import security from './suites/security.mjs';
import expiry from './suites/expiry.mjs';
import concurrency from './suites/concurrency.mjs';

const {sdk, from} = await loadSdk();
const project = await projectUnderTest();
redact(project.publishable_key, project.secret_key);
console.log(`@plexivo/client ${sdk.VERSION ?? '(no VERSION export)'} from ${from}`);
console.log(`project ${project.api_url} ${POOLED ? 'through the connection pooler (transaction mode)' : 'direct'}`);
await waitForApi(project.api_url);

const ctx = {sdk, project, pooled: POOLED};
ctx.client = (key = project.publishable_key, options = {}) => sdk.createClient(project.api_url, key, {persistSession: false, ...options});
ctx.server = ctx.client(project.secret_key);
ctx.anon = ctx.client();

let ready = false;
await check(`schema: ${SCHEMA.length} statements run with the secret key (at most 50 per transaction)`, async () => {
  for (let i = 0; i < SCHEMA.length; i += 40) await ctx.server.sqlTransaction(SCHEMA.slice(i, i + 40));
  ready = true;
});
if (!ready) finish();
await check('seed: users, profiles, posts, comments and tags written under row-level security', async () => {
  await seed(ctx);
});
if (!ctx.alice) finish();

// ONLY=auth,data runs just those suites (after the schema and seed).
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
for (const suite of [auth, data, relations, writes, server, realtime, security, expiry, concurrency]) {
  if (only && !only.has(suite.name)) continue;
  try {
    await suite(ctx);
  } catch (error) {
    await check(`${suite.name}: the suite ran to the end`, () => { throw error; });
  }
}

note('Plexivo Functions are not part of this harness (no function runtime): functions.invoke is covered by unit tests only');
finish();
