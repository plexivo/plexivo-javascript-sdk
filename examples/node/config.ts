// Shared by every Node example: the project from the environment, and a
// signed-in demo user. Copy .env.example to .env and fill it in; .env is
// git-ignored, and none of these values is a secret except PLEXIVO_SECRET_KEY,
// which only setup.ts reads.
import { createClient, isNotFound, PlexivoError, type PlexivoClient } from '@plexivo/client';
import type { Database } from '../database.types.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.includes('your-project')) {
    console.error(`Set ${name} in examples/node/.env (see .env.example).`);
    process.exit(2);
  }
  return value;
}

/** The project URL and publishable key, from the database's Connect tab. */
export const projectUrl = required('PLEXIVO_URL');
export const publishableKey = required('PLEXIVO_PUBLISHABLE_KEY');

/** A client typed with your tables (see database.types.ts). */
export function connect(): PlexivoClient<Database> {
  return createClient<Database>(projectUrl, publishableKey, { persistSession: false });
}

/**
 * Signs in as PLEXIVO_EXAMPLE_EMAIL, creating the account the first time.
 * Without one (or with `fresh`), a new demo account is made for this run.
 */
export async function signIn(db: PlexivoClient<Database>, { fresh = false } = {}): Promise<string> {
  const email = (!fresh && process.env.PLEXIVO_EXAMPLE_EMAIL) || `demo-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = process.env.PLEXIVO_EXAMPLE_PASSWORD ?? 'a long demo password 2026';
  try {
    const session = await db.auth.signInWithPassword({ email, password });
    return session.user.id;
  } catch (error) {
    if (!(error instanceof PlexivoError) || (error.code !== 'invalid_credentials' && !isNotFound(error))) throw error;
    const session = await db.auth.signUp({ email, password });
    return session.user.id;
  }
}
