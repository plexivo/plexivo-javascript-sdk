import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient, belongsTo, hasMany, hasOne, manyToMany, RecordNotFoundError, isNotFound} from '../src/index.js';

// A client whose fetch records each request and answers from `reply`.
function harness(reply = () => ({data: []}), key = 'plx_publishable_test') {
  const sent = [];
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({url: String(url), method: init.method || 'GET', body, headers: init.headers});
    const out = await reply(body, String(url));
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), {status: 200});
  };
  const db = createClient('https://api.example/client/v1/demo', key, {fetch, persistSession: false});
  return {db, sent, last: () => sent.at(-1).body};
}

test('where: values, operators, maps, nulls, lists, groups and SQL precedence', async () => {
  const {db, last} = harness();
  await db.from('posts')
    .where('likes', '>', 10)
    .where({published: true, deleted_at: null})
    .orWhere('title', 'ilike', '%gb')
    .where((q) => q.where('a', 1).orWhere('b', 'in', [2, 3]))
    .whereNot('author_id', [1, 2])
    .whereBetween('score', 1, 5)
    .whereNull('archived_at')
    .where('tags', 'not in', ['x'])
    .where('created_at', '<', new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(last().where, {
    or: [
      {and: [{column: 'likes', op: 'gt', value: 10}, {and: [{column: 'published', op: 'eq', value: true}, {column: 'deleted_at', op: 'is', value: null}]}]},
      {and: [
        {column: 'title', op: 'ilike', value: '%gb'},
        {or: [{column: 'a', op: 'eq', value: 1}, {column: 'b', op: 'in', value: [2, 3]}]},
        {not: {column: 'author_id', op: 'in', value: [1, 2]}},
        {and: [{column: 'score', op: 'gte', value: 1}, {column: 'score', op: 'lte', value: 5}]},
        {column: 'archived_at', op: 'is', value: null},
        {not: {column: 'tags', op: 'in', value: ['x']}},
        {column: 'created_at', op: 'lt', value: '2026-01-01T00:00:00.000Z'}
      ]}
    ]
  });
  assert.equal(last().op, 'select');
  assert.equal(last().from, 'posts');
});

test('json paths, arrays, search, select aliases, order with nulls, paging, distinct and locks', async () => {
  const {db, last} = harness();
  await db.from('posts')
    .select('id', 'title as heading', {writer: 'author_id'})
    .whereJson('meta', 'lang.code', 'hi')
    .whereJson('meta', ['level'], '>=', 2)
    .whereContains('labels', ['elixir'])
    .whereSearch('body', 'fast cars', 'english')
    .order('likes', 'desc', {nulls: 'last'})
    .order('id')
    .page(3, 25)
    .distinct('author_id')
    .lockForUpdate({skipLocked: true});
  const q = last();
  assert.deepEqual(q.select, ['id', {column: 'title', as: 'heading'}, {column: 'author_id', as: 'writer'}]);
  assert.deepEqual(q.where.and[0], {column: 'meta', path: ['lang', 'code'], op: 'eq', value: 'hi'});
  assert.deepEqual(q.where.and[1], {column: 'meta', path: ['level'], op: 'gte', value: 2});
  assert.deepEqual(q.where.and[2], {column: 'labels', op: 'cs', value: ['elixir']});
  assert.deepEqual(q.where.and[3], {column: 'body', op: 'wfts(english)', value: 'fast cars'});
  assert.deepEqual(q.order, [{column: 'likes', dir: 'desc', nulls: 'last'}, {column: 'id', dir: 'asc'}]);
  assert.equal(q.limit, 25);
  assert.equal(q.offset, 50);
  assert.deepEqual(q.distinct, ['author_id']);
  assert.deepEqual(q.lock, {strength: 'update', wait: 'skip_locked'});
});

test('first, last, take: ordered by primary key, limited to one, RecordNotFoundError when empty', async () => {
  let rows = [{id: 7}];
  const {db, last} = harness(() => ({data: rows}));
  assert.deepEqual(await db.from('posts').first(), {id: 7});
  assert.deepEqual(last().order, [{column: 'id', dir: 'asc'}]);
  assert.equal(last().limit, 1);
  await db.from('posts').first(7);
  assert.deepEqual(last().where, {column: 'id', op: 'eq', value: 7});
  await db.from('posts').order('likes', 'desc').last();
  assert.deepEqual(last().order, [{column: 'likes', dir: 'asc'}]);
  await db.from('posts').take();
  assert.equal(last().order, undefined);
  rows = [];
  await assert.rejects(db.from('posts').first(), (e) => e instanceof RecordNotFoundError && isNotFound(e));
  assert.equal(await db.from('posts').firstOrNull(), null);
  await db.from('posts').find([1, 2]);
  assert.deepEqual(last().where, {column: 'id', op: 'in', value: [1, 2]});
});

test('count, exists, pluck, sums and grouped aggregates with having and order', async () => {
  const {db, last} = harness((body) => {
    if (body.op === 'aggregate' && body.group_by) return {data: [{author_id: 1, count: 2}]};
    if (body.op === 'aggregate') return {data: {count: 4, sum: {likes: '70'}, avg: {likes: '17.5'}, max: {likes: 40}}};
    return {data: [{title: 'A'}, {title: 'B'}]};
  });
  assert.equal(await db.from('posts').where('published', true).count(), 4);
  assert.deepEqual(last(), {op: 'aggregate', from: 'posts', where: {column: 'published', op: 'eq', value: true}, count: true});
  assert.equal(await db.from('posts').sum('likes'), 70);
  assert.equal(await db.from('posts').avg('likes'), 17.5);
  assert.equal(await db.from('posts').max('likes'), 40);
  assert.deepEqual(await db.from('posts').pluck('title'), ['A', 'B']);
  assert.deepEqual(last().select, ['title']);
  assert.equal(await db.from('posts').exists(), true);

  await db.from('posts').groupBy('author_id').having('sum(likes) > ?', 10).having('count', '>=', 2).order('count(*) desc').limit(5).aggregate({count: true, sum: 'likes'});
  assert.deepEqual(last(), {
    op: 'aggregate', from: 'posts', group_by: ['author_id'],
    having: {and: [{fn: 'sum', column: 'likes', op: 'gt', value: 10}, {fn: 'count', op: 'gte', value: 2}]},
    order: [{fn: 'count', dir: 'desc'}], limit: 5, count: true, sum: ['likes']
  });
});

test('writes: create one or many, upsert with chosen columns, save, update, counters, delete', async () => {
  const {db, last} = harness((body) => ({data: [].concat(body.values || [{id: 1}]).map((v, i) => ({id: i + 1, ...v})), count: 1}));
  assert.deepEqual(await db.from('tags').create({name: 'go'}), {id: 1, name: 'go'});
  assert.deepEqual(last(), {op: 'insert', into: 'tags', values: [{name: 'go'}]});
  assert.equal((await db.from('tags').create([{name: 'a'}, {name: 'b', secret: 1}], {omit: ['secret']})).length, 2);
  assert.deepEqual(last().values, [{name: 'a'}, {name: 'b'}]);

  await db.from('products').upsert({sku: 'A1', price: 11}, {onConflict: 'sku', update: ['price']});
  assert.deepEqual(last(), {op: 'insert', into: 'products', values: [{sku: 'A1', price: 11}], on_conflict: ['sku'], upsert: 'merge', update_columns: ['price']});
  await db.from('tags').upsert([{name: 'x'}], {onConflict: ['name'], ignore: true});
  assert.equal(last().upsert, 'ignore');
  await db.from('tags').save({id: 4, name: 'y'});
  assert.deepEqual(last().on_conflict, ['id']);
  await db.from('tags').save({name: 'new'});
  assert.equal(last().upsert, undefined);

  await db.from('posts').where('id', 3).update({title: 'T'});
  assert.deepEqual(last(), {op: 'update', table: 'posts', set: {title: 'T'}, where: {column: 'id', op: 'eq', value: 3}});
  await db.from('products').where('sku', 'A1').decrement('stock', 2);
  assert.deepEqual(last(), {op: 'update', table: 'products', inc: {stock: -2}, where: {column: 'sku', op: 'eq', value: 'A1'}});
  await db.from('posts').where('id', 9).delete();
  assert.deepEqual(last(), {op: 'delete', from: 'posts', where: {column: 'id', op: 'eq', value: 9}});

  // The 0.1 forms still work.
  await db.from('posts').update(3, {title: 'U'});
  assert.deepEqual(last().where, {column: 'id', op: 'eq', value: 3});
  await db.from('posts').delete(5);
  assert.deepEqual(last().where, {column: 'id', op: 'eq', value: 5});
});

test('models: relations compile to embeds and joins, shaped back as promised', async () => {
  const {db, last} = harness((body) => {
    if (body.op !== 'select') return {data: []};
    return {data: [{
      id: 1, title: 'T',
      author: {name: 'Asha'},
      cover: [{url: 'c.png'}],
      __m2m_tags: [{__target: {id: 2, name: 'b'}}, {__target: {id: 1, name: 'a'}}, {__target: null}],
      comments_count: {count: 3}
    }]};
  });
  db.model('posts', {
    relations: {
      author: belongsTo('authors', {foreignKey: 'author_id'}),
      cover: hasOne('images', {foreignKey: 'post_id'}),
      comments: hasMany('comments', {foreignKey: 'post_id'}),
      tags: manyToMany('tags', {through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id'})
    }
  });
  db.model('comments', {softDelete: 'deleted_at'});

  const [row] = await db.from('posts')
    .preload('author', (a) => a.select('name'))
    .preload('cover')
    .preload('tags', (t) => t.order('name'))
    .withCount('comments', (c) => c.where('approved', true))
    .whereHas('tags', (t) => t.where('name', 'elixir'))
    .joins('comments');

  assert.deepEqual(row, {id: 1, title: 'T', author: {name: 'Asha'}, cover: {url: 'c.png'}, tags: [{id: 1, name: 'a'}, {id: 2, name: 'b'}], comments_count: 3});
  const q = last();
  assert.deepEqual(q.select[0], '*');
  assert.deepEqual(q.select[1], {embed: 'authors', as: 'author', inner: false, select: ['name']});
  assert.deepEqual(q.select[3], {
    embed: 'post_tags', as: '__m2m_tags', inner: false,
    select: [{embed: 'tags', as: '__target', inner: true}]
  });
  assert.deepEqual(q.select[4], {aggregate: 'comments', as: 'comments_count', count: true, where: {column: 'approved', op: 'eq', value: true}});
  // A soft-deleted comment does not count as a join match.
  assert.deepEqual(q.select[5], {embed: 'comments', as: 'comments', inner: true, where: {column: 'deleted_at', op: 'is', value: null}});
  assert.deepEqual(q.where, {has: 'post_tags', where: {has: 'tags', where: {column: 'name', op: 'eq', value: 'elixir'}}});
});

test('soft deletes: hidden by default, deleted by update, restorable, unscoped and force-deleted', async () => {
  const {db, last} = harness(() => ({data: [{id: 1}]}));
  db.model('notes', {softDelete: 'deleted_at'});
  await db.from('notes').where('id', 1);
  assert.deepEqual(last().where, {and: [{column: 'id', op: 'eq', value: 1}, {column: 'deleted_at', op: 'is', value: null}]});
  await db.from('notes').where('id', 1).delete();
  assert.equal(last().op, 'update');
  assert.ok(typeof last().set.deleted_at === 'string');
  await db.from('notes').unscoped().where('id', 1);
  assert.deepEqual(last().where, {column: 'id', op: 'eq', value: 1});
  await db.from('notes').where('id', 1).forceDelete();
  assert.equal(last().op, 'delete');
  await db.from('notes').where('id', 1).restore();
  assert.deepEqual(last().set, {deleted_at: null});
  // The soft-delete condition is not a filter: a write without where() is refused before it is sent.
  await assert.rejects(db.from('notes').update({body: 'all'}), (e) => e.code === 'missing_where');
  await assert.rejects(db.from('notes').delete(), (e) => e.code === 'missing_where');
  await db.from('notes').allowGlobalUpdate().update({body: 'all'});
  assert.deepEqual(last().where, {column: 'deleted_at', op: 'is', value: null});
  await db.from('notes').onlyTrashed();
  assert.deepEqual(last().where, {not: {column: 'deleted_at', op: 'is', value: null}});
});

test('hooks run in GORM order and can change rows; scopes are reusable', async () => {
  const calls = [];
  const {db, last} = harness((body) => ({data: (body.values || [{id: 1, title: 'x'}]).map((v) => ({id: 1, ...v}))}));
  db.model('posts', {
    hooks: {
      beforeSave: (r) => { calls.push('beforeSave'); return {...r, saved: true}; },
      beforeCreate: (r) => { calls.push('beforeCreate'); return {...r, slug: r.title.toLowerCase()}; },
      afterCreate: () => calls.push('afterCreate'),
      afterSave: () => calls.push('afterSave'),
      afterFind: (r) => ({...r, found: true})
    },
    scopes: {published: (q) => q.where('published', true)}
  });
  await db.from('posts').create({title: 'Hello'});
  assert.deepEqual(calls, ['beforeSave', 'beforeCreate', 'afterCreate', 'afterSave']);
  assert.deepEqual(last().values, [{title: 'Hello', saved: true, slug: 'hello'}]);
  const rows = await db.from('posts').scopes('published', (q) => q.limit(2));
  assert.equal(rows[0].found, true);
  assert.deepEqual(last().where, {column: 'published', op: 'eq', value: true});
  assert.equal(last().limit, 2);
});

test('transactions: one request, references between operations, results in order', async () => {
  const {db, sent} = harness((body, url) => {
    if (url.endsWith('/transaction')) {
      return {results: body.operations.map((op, i) => ({data: [{id: 10 + i, ...(op.values?.[0] || {})}], count: 1}))};
    }
    return {data: []};
  });
  let author;
  const results = await db.transaction((tx) => {
    author = tx.from('authors').create({name: 'Asha'});
    tx.from('posts').create({title: 'Hi', author_id: author.ref('id')});
    tx.from('products').where('sku', 'A1').lockForUpdate().find();
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.endsWith('/query/v1/transaction'));
  assert.deepEqual(sent[0].body.operations[1].values[0].author_id, {$ref: '0.data.0.id'});
  assert.deepEqual(sent[0].body.operations[2].lock, {strength: 'update'});
  assert.equal(results.length, 3);
  assert.deepEqual(await author, {id: 10, name: 'Asha'});
});

test('transactions: awaiting an operation inside sends what came before; later operations are refused clearly', async () => {
  const {db} = harness((body) => ({results: body.operations.map(() => ({data: [{id: 1}]}))}));
  await assert.rejects(db.transaction(async (tx) => {
    await tx.from('a').create({x: 1});
    tx.from('b').create({y: 2});
  }), (e) => e.code === 'transaction_already_sent');
});

test('transactions: a failure rejects every operation and names the one that failed', async () => {
  const {db} = harness(() => new Response(JSON.stringify({error: {code: 'foreign_key_violation', message: 'no author'}}), {
    status: 409, headers: {'x-plexivo-failed-operation': '1'}
  }));
  let first;
  await assert.rejects(db.transaction((tx) => {
    first = tx.from('a').create({x: 1});
    tx.from('b').create({y: 2});
  }), (e) => e.code === 'foreign_key_violation' && e.operation === 1 && e.message === 'no author');
  await assert.rejects(first);
});

test('association mode compiles to the right writes', async () => {
  const {db, sent} = harness((body, url) => (url.endsWith('/transaction') ? {results: body.operations.map(() => ({data: []}))} : {data: [], count: 0}));
  const Post = db.model('posts', {
    relations: {
      tags: manyToMany('tags', {through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id'}),
      comments: hasMany('comments', {foreignKey: 'post_id'})
    }
  });
  await Post.association({id: 1}, 'tags').append([{id: 5}, 6]);
  assert.deepEqual(sent.at(-1).body, {op: 'insert', into: 'post_tags', values: [{post_id: 1, tag_id: 5}, {post_id: 1, tag_id: 6}], on_conflict: ['post_id', 'tag_id'], upsert: 'ignore'});
  await Post.association(1, 'tags').replace([7]);
  assert.deepEqual(sent.at(-1).body.operations.map((o) => o.op), ['delete', 'insert']);
  await Post.association(1, 'tags').count();
  assert.deepEqual(sent.at(-1).body, {op: 'aggregate', from: 'post_tags', where: {column: 'post_id', op: 'eq', value: 1}, count: true});
  await Post.association(1, 'comments').append([{body: 'new'}, {id: 3}]);
  assert.deepEqual(sent.at(-1).body.operations, [
    {op: 'update', table: 'comments', set: {post_id: 1}, where: {column: 'id', op: 'in', value: [3]}},
    {op: 'insert', into: 'comments', values: [{body: 'new', post_id: 1}]}
  ]);
});

test('findInBatches walks by primary key with a cursor', async () => {
  const pages = [[{id: 1}, {id: 2}], [{id: 3}]];
  const {db, sent} = harness(() => ({data: pages.shift() || []}));
  const seen = [];
  await db.from('t').findInBatches(2, (rows) => { seen.push(rows.map((r) => r.id)); });
  assert.deepEqual(seen, [[1, 2], [3]]);
  assert.deepEqual(sent[1].body.where, {column: 'id', op: 'gt', value: 2});
});

test('paginate returns the page with its total', async () => {
  const {db, last} = harness(() => ({data: [{id: 3}], count: 41}));
  const page = await db.from('t').paginate({page: 3, perPage: 20});
  assert.deepEqual(page, {data: [{id: 3}], total: 41, page: 3, perPage: 20, totalPages: 3});
  assert.equal(last().count, true);
  assert.equal(last().offset, 40);
});

test('raw SQL: tagged templates become parameters; migrations generate safe DDL', async () => {
  const {db, sent} = harness((body) => {
    const sql = body?.statements?.[0]?.sql || '';
    if (sql.includes('to_regclass')) return {results: [{rows: [{ok: false}]}]};
    if (sql.startsWith('SELECT id FROM')) return {results: [{rows: [{id: 'one'}]}]};
    return {results: body.statements.map(() => ({rows: [{n: 1}], command: 'select', row_count: 1}))};
  }, 'plx_secret_test');
  const name = "O'Brien";
  assert.deepEqual(await db.sql`select * from users where name = ${name} and age > ${30}`, [{n: 1}]);
  assert.deepEqual(sent.at(-1).body.statements[0], {sql: 'select * from users where name = $1 and age > $2', params: ["O'Brien", 30]});
  assert.deepEqual(await db.exec('update t set x = $1', [1]), {command: 'select', rowCount: 1});

  const Post = db.model('posts', {
    columns: {
      id: {type: 'bigint', identity: true, primaryKey: true},
      title: {type: 'text', notNull: true},
      status: {type: 'text', default: "'draft'"},
      author_id: {type: 'int', references: 'authors(id)', onDelete: 'cascade', index: true},
      created_at: {type: 'timestamptz', notNull: true, default: 'now()'}
    },
    indexes: [{columns: ['title'], unique: true}],
    policies: [{name: 'read', for: 'select', to: ['anon', 'authenticated'], using: 'true'}]
  });
  const ddl = await db.migrator.autoMigrate(Post);
  assert.deepEqual(ddl, [
    'CREATE TABLE IF NOT EXISTS "posts" ("id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "title" text NOT NULL, "status" text DEFAULT \'draft\', "author_id" int REFERENCES "authors" ("id") ON DELETE CASCADE, "created_at" timestamptz NOT NULL DEFAULT now())',
    'CREATE INDEX IF NOT EXISTS "posts_author_id_idx" ON "posts" ("author_id")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "posts_title_key" ON "posts" ("title")',
    'ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY',
    'CREATE POLICY "read" ON "posts" AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true)'
  ]);

  const applied = await db.migrate([
    {id: 'one', up: 'create table a (id int)'},
    {id: 'two', up: (m) => m.addColumn('a', 'name', 'text')}
  ]);
  assert.deepEqual(applied, ['two']);
  assert.deepEqual(sent.at(-1).body.statements.map((s) => s.sql), [
    'ALTER TABLE "a" ADD COLUMN IF NOT EXISTS "name" text',
    'INSERT INTO "plexivo_migrations" (id) VALUES ($1)'
  ]);
});

test('OAuth with PKCE: an S256 challenge out, the verifier back with the code', async () => {
  const values = new Map();
  const storage = {getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k)};
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({url, body: init.body && JSON.parse(init.body)});
    return new Response(JSON.stringify({access_token: 'a', refresh_token: 'r'}), {status: 200});
  };
  const db = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, storage});
  const {url, codeVerifier} = await db.auth.signInWithOAuth({provider: 'github', redirectTo: 'https://app.example/cb', skipBrowserRedirect: true});
  const u = new URL(url);
  assert.equal(u.pathname, '/client/v1/demo/auth/oauth/github/authorize');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  await db.auth.exchangeCodeForSession('the-code');
  assert.deepEqual(sent.at(-1).body, {code: 'the-code', code_verifier: codeVerifier});
  assert.equal(db.auth.getSession().access_token, 'a');
});
