// A todo list: create, read with filters, order and pages, update, delete.
// Row-level security keeps each user's todos their own.
//
//   node --env-file=examples/node/.env examples/node/todos.ts
import { isPermissionDenied, PlexivoError } from '@plexivo/client';
import { connect, signIn } from './config.ts';

const db = connect();
await signIn(db);

// Create: one row back, or many.
const first = await db.from('todos').create({ title: 'Buy milk' });
await db.from('todos').create([
  { title: 'Book flights' },
  { title: 'Call mum', done: true },
  { title: 'File taxes' }
]);
console.log('created', first.id, first.title);

// Read: filters, order, pagination. Supabase-style names work too
// (.eq, .ilike, .order(col, { ascending: false }), .range(0, 9)).
const open = await db.from('todos')
  .select('id, title, done')
  .where('done', false)
  .whereILike('title', '%b%')
  .order('created_at', 'desc')
  .limit(10);
console.log('open todos with a b:', open.map((t) => t.title));

const page = await db.from('todos').order('id').paginate({ page: 1, perPage: 2 });
console.log(`page ${page.page} of ${page.totalPages}:`, page.data.map((t) => t.title));

const { data, count } = await db.from('todos').select('*', { count: 'exact' }).eq('done', true);
console.log(`${count} done:`, data.map((t) => t.title));

// One row by primary key; RecordNotFoundError when it isn't there (or isn't yours).
const todo = await db.from('todos').first(first.id);

// Update: always with a filter (an unfiltered update is refused before it is sent).
const [updated] = await db.from('todos').where('id', todo.id).update({ done: true });
console.log('updated', updated.title, '→ done:', updated.done);

// Count and exists.
console.log('total', await db.from('todos').count(), '· any open?', await db.from('todos').where('done', false).exists());

// Errors are PlexivoError with a code you can branch on.
try {
  await db.from('todos').create({ title: '' }); // the CHECK constraint refuses it
} catch (error) {
  if (error instanceof PlexivoError) console.log('refused:', error.code, error.message);
  if (isPermissionDenied(error)) console.log('row-level security said no');
}

// Delete.
await db.from('todos').where('id', first.id).delete();
console.log('deleted', first.id);
