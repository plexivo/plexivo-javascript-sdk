// Plexivo Postgres authentication: sign up, sign in, the session, the
// signed-in devices and sign out.
//
//   node --env-file=examples/node/.env examples/node/auth.ts
import { PlexivoError } from '@plexivo/client';
import { connect } from './config.ts';

const db = connect();

// Every change of session, as it happens.
const { data: { subscription } } = db.auth.onAuthStateChange((event, session) => {
  console.log(`auth: ${event}`, session ? `as ${session.user.email}` : '');
});

const email = process.env.PLEXIVO_EXAMPLE_EMAIL ?? `demo-${crypto.randomUUID().slice(0, 8)}@example.com`;
const password = process.env.PLEXIVO_EXAMPLE_PASSWORD ?? 'a long demo password 2026';

// Sign up (or sign in when the account already exists).
try {
  await db.auth.signUp({ email, password });
} catch (error) {
  if (error instanceof PlexivoError && error.code === 'email_taken') {
    await db.auth.signInWithPassword({ email, password });
  } else {
    throw error;
  }
}

// The session is kept on the client; requests now run as this user.
const session = db.auth.getSession();
console.log('signed in as', session?.user.email, `(token valid ${session?.expires_in}s)`);

// The user, as the server sees them.
const user = await db.auth.getUser();
console.log('user id', user.id);

// Wrong passwords fail with a PlexivoError you can show.
try {
  await db.auth.signInWithPassword({ email, password: 'not the password' });
} catch (error) {
  if (error instanceof PlexivoError) console.log('wrong password →', error.status, error.code);
}
await db.auth.signInWithPassword({ email, password });

// Signed-in devices: list them, and sign one out remotely.
const devices = await db.auth.listSessions();
console.log(`${devices.length} signed-in device(s); this one is`, devices.find((d) => d.current)?.id);

// Sign out this device ({ scope: 'global' } signs out every device).
await db.auth.signOut();
console.log('signed out; session is', db.auth.getSession());
subscription.unsubscribe();
