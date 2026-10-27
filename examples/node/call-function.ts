// Calling a Plexivo Function: your server-side code beside the data.
// Deploy examples/functions/hello.js as `hello` from the database's
// Functions tab first.
//
//   node --env-file=examples/node/.env examples/node/call-function.ts
import { PlexivoError } from '@plexivo/client';
import { connect, signIn } from './config.ts';

type Hello = { message: string; signedIn: boolean; method: string };

const db = connect();

// Signed out. By default a function accepts only signed-in users (and
// servers); untick "Only signed-in users…" on the Functions tab to open it.
try {
  const { data } = await db.functions.invoke<Hello>('hello', { body: { name: 'visitor' } });
  console.log('signed out:', data.message);
} catch (error) {
  if (!(error instanceof PlexivoError)) throw error;
  console.log('signed out: refused with', error.status, error.code);
}

// Signed in: the user's token travels with the call, so ctx.user is set.
await signIn(db);
const posted = await db.functions.invoke<Hello>('hello', { body: { name: 'Plexivo' } });
console.log(posted.status, posted.data.message, '· signed in:', posted.data.signedIn);

// Any method, a sub-path and a query string.
const fetched = await db.functions.invoke<Hello>('hello', { method: 'GET', query: { name: 'friend' } });
console.log(fetched.data.method, fetched.data.message);

// A function that isn't deployed fails like everything else: a PlexivoError.
try {
  await db.functions.invoke('no-such-function');
} catch (error) {
  if (error instanceof PlexivoError) console.log('missing function →', error.status, error.code);
}
