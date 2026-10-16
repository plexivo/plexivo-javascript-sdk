# Plexivo Client for JavaScript and TypeScript

`@plexivo/client` is the client for **Plexivo Postgres**: your database, its Data API, authentication, realtime, GraphQL, functions and file storage, from the browser, React Native, Vue or Node.

It gives you two ways to work with data on one query builder:

- **Supabase-style**: `from('notes').select('id, body').eq('pinned', true)`, which returns `{data, count}`.
- **GORM-style**: models, relations, `preload`, `whereHas`, `first`, `create`, `save`, scopes, hooks, soft deletes, transactions, association mode, plus migrations and raw SQL on your server.

Row-level security decides what every request can read and write.

```sh
npm install @plexivo/client
```

```js
import { createClient } from '@plexivo/client';

const db = createClient(PLEXIVO_DATA_URL, PLEXIVO_PUBLISHABLE_KEY);
await db.auth.signInWithPassword({ email, password });

const posts = await db.from('posts')
  .where('likes', '>', 10)
  .preload('author')
  .order('created_at', 'desc')
  .limit(20);
```

Your data URL and publishable key are on the database's **Connect** tab. The publishable key is safe in an app. The **secret key** is for servers only: it bypasses row-level security and can run raw SQL and migrations. Never put the secret key in a browser or mobile bundle.

---

## Contents

- [Queries](#queries)
- [Results](#results)
- [Writes](#writes)
- [Models and relations](#models-and-relations)
- [Aggregates and groups](#aggregates-and-groups)
- [Transactions](#transactions)
- [Server: raw SQL and migrations](#server-raw-sql-and-migrations)
- [Authentication](#authentication)
- [Realtime](#realtime)
- [GraphQL](#graphql), [functions](#functions), [files](#files), [RPC](#rpc)
- [Types](#types)
- [Errors](#errors)
- [Coming from GORM](#coming-from-gorm)

---

## Queries

A query builder is immutable and chainable. Awaiting it runs it.

```js
// Conditions: value, operator, map, null, list, group
db.from('posts')
  .where('likes', '>', 10)
  .where({ published: true, deleted_at: null })        // null → IS NULL
  .orWhere('title', 'ilike', '%postgres%')             // AND binds tighter than OR, as in SQL
  .where((q) => q.where('a', 1).orWhere('b', 'in', [2, 3]))
  .whereNot('author_id', [1, 2])
  .whereBetween('score', 1, 5)
  .whereIn('id', [1, 2, 3]).whereNotIn('id', [4])
  .whereNull('archived_at').whereNotNull('slug')

// JSON, arrays and full-text search
db.from('posts').whereJson('meta', 'lang.code', 'hi')
db.from('posts').whereJson('meta', ['level'], '>=', 2)       // numbers compare as numbers
db.from('posts').whereContains('tags', ['postgres'])         // arrays and jsonb
db.from('posts').whereOverlaps('tags', ['go', 'rust'])
db.from('posts').whereSearch('body', 'fast cars', 'english')

// Related rows
db.from('posts').whereHas('comments', (c) => c.where('approved', true))
db.from('posts').whereDoesntHave('comments')

// Shape, order and page
db.from('posts').select('id', 'title as heading', { writer: 'author_id' })
db.from('posts').order('likes', 'desc', { nulls: 'last' }).order('id')
db.from('posts').limit(20).offset(40)      // or .page(3, 20), or .range(40, 59)
db.from('posts').distinct()                // or .distinct('author_id'): one row per author
db.from('posts').latest()                  // order by created_at desc
```

Operators: `= != <> > >= < <= like ilike not like in not in is is not contains contained by overlaps match imatch fts plfts phfts wfts`. You can also use the PostgREST names (`eq`, `gte`, `cs`, …).

**Supabase-style.** The same builder speaks PostgREST:

```js
const { data, count } = await db.from('notes')
  .select('id, body, author:authors(name), comments!inner(id)', { count: 'exact' })
  .eq('pinned', true)
  .or('priority.gte.3,body.ilike.*urgent*')
  .order('id', { ascending: false })
  .range(0, 19);

const { data: note } = await db.from('notes').select().eq('id', 1).single();
```

Reading terminals:

| Method | Returns |
| --- | --- |
| `await q` / `q.find()` | rows ([Results](#results)) |
| `q.find([1, 2])` | rows with those primary keys |
| `q.first()` / `q.first(id)` | the first row by primary key, or `RecordNotFoundError` |
| `q.last()`, `q.take()` | the last row by primary key, or any one row |
| `q.firstOrNull(id?)`, `q.sole()` | the row or `null`; exactly one row |
| `q.pluck('email')` | one column's values |
| `q.count()`, `q.exists()` | a number; a boolean |
| `q.sum(c)`, `q.avg(c)`, `q.min(c)`, `q.max(c)` | one aggregate |
| `q.paginate({ page, perPage })` | `{ data, total, page, perPage, totalPages }` |
| `q.findInBatches(500, fn)`, `q.each(fn)`, `for await (const row of q)` | every row, read by primary key cursor |
| `q.single()`, `q.maybeSingle()` | `{ data }` |
| `q.toQuery()` | the operation it would send (GORM's DryRun) |

## Results

Rows come back as an array that also carries `data`, `count` and `error: null`, so both styles read naturally:

```js
const posts = await db.from('posts').limit(10);
posts.length; posts[0].title;              // an array
const { data, count } = await db.from('posts').select('*', { count: 'exact' });
```

Failures are thrown as `PlexivoError` (see [Errors](#errors)), never returned silently.

## Writes

```js
const post = await db.from('posts').create({ title: 'Hello' });              // one row back
const rows = await db.from('posts').create([{ title: 'a' }, { title: 'b' }]); // many
await db.from('posts').create(rows, { omit: ['internal'] });                  // or { only: [...] }
await db.from('posts').createInBatches(bigList, 500);

await db.from('products').upsert(item, { onConflict: 'sku', update: ['price'] }); // update only price
await db.from('tags').upsert(list, { onConflict: ['name'], ignore: true });       // ON CONFLICT DO NOTHING
await db.from('posts').save({ id: 7, title: 'New title' });                       // insert or update by key

await db.from('posts').where('id', 7).update({ title: 'T' });
await db.from('posts').update({ title: 'T' }).eq('id', 7);                         // Supabase order works too
await db.from('products').where('sku', 'A1').decrement('stock', 2);               // atomic counter
await db.from('posts').where('id', 7).delete();
await db.from('posts').delete(7);                                                  // by primary key

await db.from('products').firstOrCreate({ sku: 'D4' }, { name: 'Desk', price: 99 });
await db.from('settings').updateOrCreate({ key: 'theme' }, { value: 'dark' });
```

An update or delete must say which rows it touches. Without `where()` it is refused before it is sent (GORM's ErrMissingWhereClause); `.allowGlobalUpdate()` is the explicit opt-in. A soft-delete condition does not count as a filter.

## Models and relations

Declare a table once. Queries then understand its relations, hooks, scopes and soft deletes, and migrations understand its columns.

```js
import { createClient, belongsTo, hasOne, hasMany, manyToMany } from '@plexivo/client';

const Post = db.model('posts', {
  softDelete: 'deleted_at',
  relations: {
    author: belongsTo('authors', { foreignKey: 'author_id' }),
    cover: hasOne('images', { foreignKey: 'post_id' }),
    comments: hasMany('comments', { foreignKey: 'post_id' }),
    tags: manyToMany('tags', { through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id' })
  },
  hooks: {
    beforeCreate: (row) => ({ ...row, slug: slugify(row.title) }),
    afterFind: (row) => ({ ...row, url: `/posts/${row.slug}` })
  },
  scopes: { published: (q) => q.where('published', true) }
});

const posts = await Post.query()
  .scopes('published')
  .preload('author', (a) => a.select('name').preload('avatar'))   // nested
  .preload('comments', (c) => c.where('approved', true).order('id', 'desc').limit(5))
  .preload('tags')                                                 // through the link table
  .withCount('comments')                                           // comments_count
  .joins('comments', (c) => c.where('approved', true))             // only posts with a match
  .whereHas('tags', (t) => t.where('name', 'postgres'));

await Post.first(1);                 // every builder method is on the model
await Post.where('id', 1).delete();  // sets deleted_at
await Post.query().unscoped();       // include soft-deleted rows; .onlyTrashed(), .restore(), .forceDelete()
```

Without a model, a relation is just a table name, and your foreign keys decide how rows relate: `from('posts').preload('authors')`, or `'authors!fk_name'` when two keys relate the same tables.

Hooks: `beforeSave`, `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `afterSave`, `beforeDelete`, `afterDelete`, `afterFind`, run in GORM's order. A hook may return a changed row; throwing stops the write.

**Association mode**, as in GORM:

```js
const tags = Post.association(post, 'tags');
await tags.append([elixir, postgresId]);
await tags.replace([flutter]);       // one transaction
await tags.delete([elixir]);         // removes the link, not the tag
await tags.clear();
await tags.count();
await tags.find((q) => q.order('name'));

await Author.association(ben, 'posts').append([{ title: 'New' }]);  // creates with author_id set
```

## Aggregates and groups

```js
await db.from('posts').where('published', true).count();
await db.from('posts').aggregate({ count: true, sum: ['likes'], avg: ['likes'], max: ['likes'] });

await db.from('posts')
  .groupBy('author_id')
  .having('sum(likes) > ?', 100)          // or .having('count', '>=', 2), .having('sum', 'likes', '>', 100)
  .order('count(*) desc')
  .limit(10)
  .aggregate({ count: true, sum: 'likes' });
// → [{ author_id: 1, count: 2, sum: { likes: '165' } }, …]
```

Sums and averages come back as text so no digit is lost.

## Transactions

Several operations commit together or not at all. Record them on `tx` **without awaiting**, and pass one result to the next with `.ref()`:

```js
const [author, post] = await db.transaction((tx) => {
  const author = tx.from('authors').create({ name: 'Asha' });
  tx.from('posts').create({ title: 'Hello', author_id: author.ref('id') });
  tx.from('products').where('sku', 'B2').lockForUpdate().find();   // row lock until commit
  tx.from('products').where('sku', 'B2').decrement('stock');
});
```

If any step fails, everything is rolled back and the error names the step (`error.operation`). The transaction travels as one request. If you await an operation inside the callback, what came before it is sent, and anything recorded after it is refused with `transaction_already_sent`. For logic that must read and then decide inside the database, use a database function with [RPC](#rpc), or raw SQL on your server.

## Server: raw SQL and migrations

With the **secret key**, on a server only:

```js
const server = createClient(PLEXIVO_DATA_URL, process.env.PLEXIVO_SECRET_KEY, { persistSession: false });

const big = await server.sql`select * from orders where total > ${100} and status = ${'paid'}`;
await server.raw('select * from orders where id = $1', [id]);
await server.exec('update orders set status = $1 where id = $2', ['shipped', id]);
await server.sqlTransaction(['create table a (id int)', { sql: 'insert into a values ($1)', params: [1] }]);
```

**Auto-migrate from models.** Like GORM's AutoMigrate, it creates missing tables, columns, indexes, row-level security and policies, and never drops or changes anything:

```js
const Post = server.model('posts', {
  columns: {
    id: 'bigserial primary key',
    author_id: { type: 'bigint', references: 'authors(id)', onDelete: 'cascade', index: true },
    title: { type: 'text', notNull: true },
    status: { type: 'text', default: "'draft'" },          // defaults are SQL
    created_at: { type: 'timestamptz', notNull: true, default: 'now()' }
  },
  indexes: [{ columns: ['author_id', 'created_at'] }],
  policies: [
    { name: 'read', for: 'select', to: ['anon', 'authenticated'], using: 'true' },
    { name: 'own', for: 'all', to: 'authenticated', using: 'author_id = auth.uid()', check: 'author_id = auth.uid()' }
  ]
});
await server.migrator.autoMigrate(Post, Comment, Tag);
```

A table appears in the Data API once row-level security is on and it has a policy.

**Versioned migrations**, each applied once and recorded in `plexivo_migrations`:

```js
const migrations = [
  { id: '2026_10_17_01_tags', up: 'create table tags (id bigserial primary key, name text unique)', down: 'drop table tags' },
  { id: '2026_10_17_02_slug', up: (m) => m.addColumn('posts', 'slug', 'text').createIndex('posts', 'slug', { unique: true }),
    down: (m) => m.dropColumn('posts', 'slug') }
];
await server.migrate(migrations);
await server.rollback(migrations, { steps: 1 });
```

The migrator also has `hasTable`, `hasColumn`, `columns`, `tables`, `createTable`, `dropTable`, `renameTable`, `addColumn`, `dropColumn`, `renameColumn`, `alterColumnType`, `setNotNull`, `setDefault`, `createIndex`, `dropIndex`, `addConstraint`, `dropConstraint`, `enableRowLevelSecurity`, `createPolicy` and `dropPolicy`.

All statements in one call run in one transaction.

## Authentication

Your app's own users, ready for row-level security (`auth.uid()` in policies):

```js
await db.auth.signUp({ email, password });
await db.auth.signInWithPassword({ email, password });
await db.auth.signInWithOtp({ email });  await db.auth.verifyOtp({ email, token });   // email code
await db.auth.signInAnonymously();       await db.auth.linkEmail({ email, password }); // guest → account, same id
await db.auth.signInWithOAuth({ provider: 'google', redirectTo });                     // google | github | microsoft (PKCE)
await db.auth.exchangeCodeForSession(new URL(location.href).searchParams.get('code'));
await db.auth.resetPasswordForEmail(email);
await db.auth.verifyPasswordRecovery({ email, code, newPassword });
await db.auth.updatePassword({ currentPassword, newPassword });
await db.auth.mfa.enroll();  await db.auth.mfa.verify({ code });                       // TOTP
await db.auth.listSessions(); await db.auth.revokeSession(id);                          // signed-in devices
await db.auth.signOut();      // { scope: 'global' } ends every session
db.auth.onAuthStateChange((event, session) => {});

// Organisations with roles and invitations
const team = await db.orgs.create({ name: 'Acme' });
const invite = await db.orgs.invite(team.id, { email: 'ben@acme.in', role: 'member' });
await db.orgs.acceptInvitation(invite.token);
await db.orgs.members(team.id);

// Server, secret key: bring users over with their password hashes
await server.auth.admin.importFromSupabase();
await server.auth.admin.importUsers([{ email, password_hash }]);
```

Sessions persist in `localStorage` in a browser. In React Native, pass an encrypted storage adapter (`storage: {getItem, setItem, removeItem}`). An expired access token is refreshed once and the request retried.

## Realtime

```js
// Row changes you may read, optionally filtered
db.channel('changes:orders', { filter: 'status=eq.open' })
  .onChange(({ type, record, old }) => {})          // type: insert | update | delete
  .subscribe();

// Rooms: broadcast and presence ('room:private:…' for signed-in users)
const room = db.channel('room:lobby', { presence: { name: 'Asha' } })
  .onBroadcast('cursor', (p) => {})
  .onPresence(({ event, state }) => {})
  .subscribe();
await room.ready();
room.sendBroadcast('cursor', { x: 10, y: 20 });
room.unsubscribe();
```

## GraphQL

```js
const { data, errors } = await db.graphql('query($b: String!) { notes(where: {body: {eq: $b}}) { body } }', { b: 'hi' });
await db.graphql('{ notesAggregate { count } }', {}, { persisted: true });   // automatic persisted queries
const live = db.graphql.subscribe('subscription { notes { body } }', {}, ({ data }) => {}); // updates on change
live.unsubscribe();
```

## Functions

```js
const { data } = await db.functions.invoke('send-receipt', { body: { orderId } });
```

## Files

```js
const object = await db.storage.upload('avatars/me.png', file, { contentType: 'image/png' });
const { data } = await db.storage.download(object.id);
const { signed_url } = await db.storage.createSignedDownloadUrl(object.id);
```

## RPC

Expose a database function with `COMMENT ON FUNCTION … IS '@expose'`, then:

```js
const { data } = await db.rpc('note_count', { owner: id });
```

## Types

Generate types from your live API, then get checked table names, columns, inserts and updates:

```js
import { renderApiTypes } from '@plexivo/client/generate-types';
fs.writeFileSync('database.ts', renderApiTypes(await db.getApi()));
```

```ts
import type { Database } from './database';
const db = createClient<Database>(url, key);
const posts = await db.from('posts').where('likes', '>', 10);   // posts: Database['public']['Tables']['posts']['Row'][]
```

## Errors

Every failure is a `PlexivoError` with `status`, `code` (`unique_violation`, `foreign_key_violation`, `check_violation`, `permission_denied`, `table_not_exposed`, `missing_where`, …), `message`, `hint`, `sqlstate` and the `traceId` to quote to support.

```js
import { isNotFound, isUniqueViolation, isPermissionDenied, RecordNotFoundError } from '@plexivo/client';

try {
  await db.from('users').first(id);
} catch (e) {
  if (isNotFound(e)) return null;
  throw e;
}
```

## Coming from GORM

| GORM | @plexivo/client |
| --- | --- |
| `db.First(&u, 10)` / `Last` / `Take` | `from('users').first(10)` / `.last()` / `.take()` |
| `db.Find(&users, []int{1,2})` | `.find([1, 2])` |
| `Where("age > ?", 18).Or(...).Not(...)` | `.where('age', '>', 18).orWhere(...).whereNot(...)` |
| `Where(map[string]any{...})` | `.where({ ... })` |
| `Select("name")`, `Omit(...)` | `.select('name')`, `create(row, { omit: [...] })` |
| `Order("age desc")`, `Limit`, `Offset` | `.order('age', 'desc')`, `.limit()`, `.offset()` |
| `Distinct`, `Group`, `Having` | `.distinct()`, `.groupBy()`, `.having()` |
| `Joins("Company")` / `InnerJoins` | `.joins('company')` |
| `Preload("Orders", "state = ?", "paid")` | `.preload('orders', (o) => o.where('state', 'paid'))` |
| `Count`, `Pluck`, `Scan` | `.count()`, `.pluck()`, `.aggregate()` |
| `Create`, `CreateInBatches`, `Save` | `.create()`, `.createInBatches()`, `.save()` |
| `Clauses(clause.OnConflict{...})` | `.upsert(rows, { onConflict, update, ignore })` |
| `Update`, `Updates`, `UpdateColumn` | `.update()`, `.updateColumn()` |
| `gorm.Expr("stock - ?", 1)` | `.decrement('stock', 1)` |
| `Delete`, soft delete, `Unscoped` | `.delete()`, `softDelete: 'deleted_at'`, `.unscoped()` |
| `FirstOrCreate`, `FirstOrInit` | `.firstOrCreate()`, `.firstOrInit()` |
| `FindInBatches`, `Rows()` | `.findInBatches()`, `for await (…)` |
| `Scopes(...)` | `.scopes(...)` |
| Hooks (`BeforeCreate` …) | `hooks: { beforeCreate … }` |
| `Transaction(func(tx) …)` | `db.transaction((tx) => …)` |
| `Clauses(clause.Locking{Strength: "UPDATE"})` | `.lockForUpdate()` |
| `Association("Languages").Append/Replace/Delete/Clear/Count` | `Model.association(row, 'languages').append/replace/delete/clear/count` |
| `Raw`, `Exec` | `server.sql\`…\``, `server.raw()`, `server.exec()` (secret key) |
| `AutoMigrate`, `Migrator()` | `server.migrator.autoMigrate()`, `server.migrator` |
| `datatypes.JSONQuery` | `.whereJson()` |
| `ErrRecordNotFound` | `RecordNotFoundError`, `isNotFound()` |
| `DryRun` | `.toQuery()` |

## Development

Requires Node.js 20 or later.

```sh
npm test
npm pack --dry-run
```

## License

Apache-2.0. See [LICENSE](LICENSE).
