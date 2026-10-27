// 0.4.0: what each new builder call compiles to, and the client behaviour
// around it, against a recording fetch and a fake WebSocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient, belongsTo, hasMany, manyToMany, PlexivoError, VERSION} from '../src/index.js';

function harness(reply = () => ({data: []}), options = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({url: String(url), method: init.method || 'GET', body, headers: new Headers(init.headers), signal: init.signal});
    const out = await reply(body, String(url), init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), {status: 200});
  };
  const db = createClient('https://api.example/client/v1/demo', options.key || 'plx_publishable_test', {fetch, persistSession: false, ...options});
  return {db, sent, last: () => sent.at(-1)};
}

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('VERSION is 0.4.0', () => {
  assert.equal(VERSION, '0.4.0');
});

test('order by a related column: dotted, {relation}, a model relation with its constraint, nulls', async () => {
  const {db, last} = harness();
  await db.from('posts').order('profiles.username', 'desc', {nulls: 'last'});
  assert.deepEqual(last().body.order, [{column: 'username', relation: 'profiles', dir: 'desc', nulls: 'last'}]);

  await db.from('posts').order('username', {relation: 'profiles', ascending: true, nullsFirst: true});
  assert.deepEqual(last().body.order, [{column: 'username', relation: 'profiles', dir: 'asc', nulls: 'first'}]);

  await db.from('posts').order('username', 'asc', {relation: 'profiles', hint: 'posts_editor_id_fkey'});
  assert.deepEqual(last().body.order, [{column: 'username', relation: 'profiles', hint: 'posts_editor_id_fkey', dir: 'asc'}]);

  db.model('posts', {relations: {editor: belongsTo('profiles', {foreignKey: 'editor_id', constraint: 'posts_editor_id_fkey'})}});
  await db.from('posts').order('editor.username desc').order('id');
  assert.deepEqual(last().body.order, [
    {column: 'username', relation: 'profiles', hint: 'posts_editor_id_fkey', dir: 'desc'},
    {column: 'id', dir: 'asc'}
  ]);
});

test('order, limit and range of an embed with referencedTable / foreignTable (Supabase)', async () => {
  const {db, last} = harness();
  await db.from('posts')
    .select('id, comments(id, body)')
    .order('created_at', {referencedTable: 'comments', ascending: false})
    .limit(3, {referencedTable: 'comments'})
    .order('id');
  const body = last().body;
  assert.deepEqual(body.order, [{column: 'id', dir: 'asc'}]);
  const embed = body.select.find((x) => x.embed === 'comments');
  assert.deepEqual(embed.order, [{column: 'created_at', dir: 'desc'}]);
  assert.equal(embed.limit, 3);

  await db.from('posts').select('id, notes:comments(id)').order('id', {foreignTable: 'notes', ascending: false});
  assert.deepEqual(last().body.select.find((x) => x.as === 'notes').order, [{column: 'id', dir: 'desc'}]);

  assert.throws(() => db.from('posts').order('id', {referencedTable: 'nope'}), TypeError);
});

test('whereIn / whereNotIn with a query compile to a subquery', async () => {
  const {db, last} = harness();
  const indian = db.from('profiles').select('id').where('country', 'IN');
  await db.from('posts').whereIn('author_id', indian).whereNotIn('editor_id', db.from('profiles').where('banned', true));
  assert.deepEqual(last().body.where, {and: [
    {column: 'author_id', op: 'in', query: {from: 'profiles', select: 'id', where: {column: 'country', op: 'eq', value: 'IN'}}},
    {not: {column: 'editor_id', op: 'in', query: {from: 'profiles', select: 'id', where: {column: 'banned', op: 'eq', value: true}}}}
  ]});

  await db.from('posts').where('author_id', db.from('profiles').select('id')).in('editor_id', db.from('profiles').select('id'));
  assert.deepEqual(last().body.where.and[0], {column: 'author_id', op: 'in', query: {from: 'profiles', select: 'id'}});
  assert.deepEqual(last().body.where.and[1], {column: 'editor_id', op: 'in', query: {from: 'profiles', select: 'id'}});

  assert.throws(() => db.from('posts').whereIn('author_id', db.from('profiles').select('id', 'name')), TypeError);
  assert.throws(() => db.from('posts').where('author_id', '>', db.from('profiles').select('id')), TypeError);
});

test('preload by path: comments.author, merged into an existing preload, many-to-many paths', async () => {
  const {db, last} = harness(() => ({data: [{id: 1, comments: [{id: 2, author: {id: 3}}]}]}));
  await db.from('posts').preload('comments.author', (a) => a.select('username'));
  assert.deepEqual(last().body.select, ['*', {embed: 'comments', as: 'comments', inner: false, select: ['*', {embed: 'author', as: 'author', inner: false, select: ['username']}]}]);

  await db.from('posts').preload('comments', (c) => c.where('approved', true)).preload('comments.author');
  const comments = last().body.select.filter((x) => x.embed === 'comments');
  assert.equal(comments.length, 1);
  assert.deepEqual(comments[0].where, {column: 'approved', op: 'eq', value: true});
  assert.deepEqual(comments[0].select, ['*', {embed: 'author', as: 'author', inner: false}]);

  db.model('posts', {relations: {
    tags: manyToMany('tags', {through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id'}),
    comments: hasMany('comments', {foreignKey: 'post_id'})
  }});
  db.model('tags', {relations: {owner: belongsTo('profiles', {foreignKey: 'owner_id'})}});
  await db.from('posts').preload('tags.owner');
  const link = last().body.select.find((x) => x.embed === 'post_tags');
  assert.deepEqual(link.select[0].select, ['*', {embed: 'profiles', as: 'owner', inner: false}]);

  await db.from('posts').joins('comments.author');
  const inner = last().body.select.find((x) => x.embed === 'comments');
  assert.equal(inner.inner, true);
  assert.equal(inner.select[1].inner, true);
});

test('rpc: plain call unchanged, chained call through the structured form', async () => {
  const {db, sent, last} = harness((body, url) => (url.includes('/rest/v1/rpc/') ? {data: 7} : {data: [{id: 1, title: 'a'}], count: 4}));
  const plain = await db.rpc('note_count', {owner: 'u1'});
  assert.deepEqual(plain, {data: 7, count: null, error: null});
  assert.match(sent[0].url, /\/rest\/v1\/rpc\/note_count$/);
  assert.deepEqual(sent[0].body, {owner: 'u1'});

  const shaped = await db.rpc('search_posts', {q: 'pg'}, {count: 'exact'})
    .select('id, title, author:profiles(username)')
    .eq('published', true)
    .order('created_at', {ascending: false})
    .range(10, 19);
  assert.match(last().url, /\/query\/v1$/);
  assert.deepEqual(last().body, {
    op: 'rpc', function: 'search_posts', args: {q: 'pg'},
    select: ['id', 'title', {embed: 'profiles', as: 'author', select: ['username']}],
    where: {column: 'published', op: 'eq', value: true},
    order: [{column: 'created_at', dir: 'desc'}],
    limit: 10, offset: 10, count: true
  });
  assert.deepEqual(shaped, {data: [{id: 1, title: 'a'}], count: 4, error: null});

  const one = await db.rpc('search_posts', {q: 'pg'}).eq('id', 1).single();
  assert.equal(last().body.limit, 2);
  assert.deepEqual(one.data, {id: 1, title: 'a'});

  const {db: db2} = harness(() => ({data: [{id: 1}, {id: 2}]}));
  await assert.rejects(db2.rpc('f').select('id').maybeSingle(), (e) => e.code === 'multiple_rows');
  const head = await db.rpc('search_posts', {q: ''}, {count: 'exact', head: true});
  assert.equal(head.data, null);
  assert.equal(head.count, 4);
});

test('rpc inside a transaction is recorded as an operation', async () => {
  const {db, last} = harness(() => ({results: [{data: 3}, {data: [{id: 1}]}]}));
  const [count] = await db.transaction((tx) => {
    tx.rpc('bump', {by: 1});
    tx.from('posts').create({title: 'x'});
  });
  assert.deepEqual(last().body.operations[0], {op: 'rpc', function: 'bump', args: {by: 1}});
  assert.deepEqual(count, {data: 3, count: null, error: null});
});

test('throwOnError: false resolves failures as {data: null, error}; the default still throws', async () => {
  const failing = () => new Response(JSON.stringify({error: {code: 'permission_denied', message: 'no', sqlstate: '42501'}, trace_id: 't1'}), {status: 403});
  const {db} = harness(failing, {throwOnError: false});
  const read = await db.from('posts').select('id');
  assert.equal(read.data, null);
  assert.equal(read.count, null);
  assert.ok(read.error instanceof PlexivoError);
  assert.equal(read.error.code, 'permission_denied');
  assert.equal(read.error.traceId, 't1');
  const write = await db.from('posts').insert({title: 'x'});
  assert.equal(write.error.status, 403);
  const rpc = await db.rpc('f', {});
  assert.equal(rpc.error.code, 'permission_denied');
  const one = await db.from('posts').eq('id', 1).single();
  assert.equal(one.error.code, 'permission_denied');

  const {db: strict} = harness(failing);
  await assert.rejects(strict.from('posts').select('id'), (e) => e.code === 'permission_denied');
  await assert.rejects(strict.rpc('f'), (e) => e.status === 403);
});

test('abortSignal cancels the request with a PlexivoError coded aborted', async () => {
  const {db, last} = harness();
  const controller = new AbortController();
  const q = db.from('posts').select('id').abortSignal(controller.signal);
  await q;
  assert.equal(last().signal, controller.signal);
  controller.abort();
  await assert.rejects(db.from('posts').abortSignal(controller.signal), (e) => e instanceof PlexivoError && e.code === 'aborted');
  await assert.rejects(db.rpc('f').abortSignal(controller.signal), (e) => e.code === 'aborted');
  const {db: soft} = harness(undefined, {throwOnError: false});
  const r = await soft.from('posts').abortSignal(controller.signal);
  assert.equal(r.error.code, 'aborted');
});

test('a network failure is a PlexivoError coded network_error', async () => {
  const db = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {
    persistSession: false,
    fetch: async () => { throw new TypeError('fetch failed'); }
  });
  await assert.rejects(db.from('posts'), (e) => e instanceof PlexivoError && e.code === 'network_error' && e.cause instanceof TypeError);
});

test('signUp sends user metadata; updateUser merges it and updates the session', async () => {
  const user = {id: 'u1', email: 'a@example.com', user_metadata: {plan: 'pro'}};
  const {db, sent} = harness((body, url, init) => {
    if (url.endsWith('/auth/signup')) return {access_token: 'a', refresh_token: 'r', user};
    if (url.endsWith('/auth/user') && init.method === 'PATCH') return {user: {...user, user_metadata: {theme: 'dark'}}};
    return {};
  });
  const events = [];
  db.auth.onAuthStateChange((event) => events.push(event));
  await db.auth.signUp({email: 'a@example.com', password: 'pw', data: {plan: 'pro'}});
  assert.deepEqual(sent[0].body, {email: 'a@example.com', password: 'pw', data: {plan: 'pro'}});
  await db.auth.signUp({email: 'b@example.com', password: 'pw', options: {data: {plan: 'team'}}});
  assert.deepEqual(sent[1].body, {email: 'b@example.com', password: 'pw', data: {plan: 'team'}});

  const updated = await db.auth.updateUser({data: {theme: 'dark', plan: null}});
  assert.equal(sent[2].method, 'PATCH');
  assert.deepEqual(sent[2].body, {data: {theme: 'dark', plan: null}});
  assert.equal(sent[2].headers.get('authorization'), 'Bearer a');
  assert.deepEqual(updated.user_metadata, {theme: 'dark'});
  assert.deepEqual(db.auth.getSession().user.user_metadata, {theme: 'dark'});
  assert.equal(events.at(-1), 'USER_UPDATED');
  await assert.rejects(db.auth.updateUser({}), TypeError);
});

test('createClient refuses the secret key in a browser, and allows it on a server', () => {
  assert.doesNotThrow(() => createClient('https://api.example/client/v1/demo', 'plx_secret_abc', {persistSession: false}));
  globalThis.window = {};
  try {
    assert.throws(
      () => createClient('https://api.example/client/v1/demo', 'plx_secret_abc', {persistSession: false}),
      (e) => e instanceof PlexivoError && e.code === 'secret_key_in_browser' && !e.message.includes('plx_secret_abc')
    );
    assert.doesNotThrow(() => createClient('https://api.example/client/v1/demo', 'plx_publishable_abc', {persistSession: false}));
  } finally {
    delete globalThis.window;
  }
});

// ── realtime ───────────────────────────────────────────────────────────────

function fakeSockets() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = new URL(url);
      this.readyState = 0;
      this.handlers = new Map();
      this.frames = [];
      sockets.push(this);
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    send(frame) { this.frames.push(JSON.parse(frame)); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', {}));
    }
    emit(name, data) { this.handlers.get(name)?.(data); }
    open() { this.readyState = 1; this.emit('open', {}); }
    reply(frame, status = 'ok', response = {}) {
      this.emit('message', {data: JSON.stringify([null, frame[1], frame[2], 'phx_reply', {status, response}])});
    }
    server(event, payload, topic = 'realtime:changes:posts') {
      this.emit('message', {data: JSON.stringify([null, null, topic, event, payload])});
    }
    join() { return this.frames.find((f) => f[3] === 'phx_join'); }
  }
  return {sockets, FakeWebSocket};
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await tick(5);
  }
  throw new Error('timed out waiting');
}

test('realtime: after the server ends the channel it refreshes the session and joins again', async () => {
  const {sockets, FakeWebSocket} = fakeSockets();
  const expired = jwt({exp: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 20});
  const fresh = jwt({exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000)});
  let refreshes = 0;
  const fetch = async (url) => {
    assert.match(String(url), /\/auth\/refresh$/);
    refreshes++;
    return new Response(JSON.stringify({access_token: fresh, refresh_token: 'r2', user: {id: 'u'}}), {status: 200});
  };
  const db = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {
    fetch, WebSocket: FakeWebSocket, persistSession: false,
    initialSession: {access_token: jwt({exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000)}), refresh_token: 'r1'}
  });
  const statuses = [];
  const changes = [];
  const errors = [];
  const ch = db.channel('changes:posts').onChange((c) => changes.push(c)).onError((e) => errors.push(e.code)).subscribe((s) => statuses.push(s));
  sockets[0].open();
  sockets[0].reply(sockets[0].join());
  await ch.ready();
  assert.equal(ch.state, 'joined');

  // The token expires; the server says so and closes the channel.
  db.auth.getSession().access_token = expired;
  sockets[0].server('system', {status: 'token_expired'});
  sockets[0].server('phx_close', {});
  await until(() => sockets.length === 2);
  assert.equal(refreshes, 1);
  assert.equal(sockets[1].url.searchParams.get('access_token'), fresh);
  sockets[1].open();
  sockets[1].reply(sockets[1].join());
  await until(() => ch.state === 'joined');
  sockets[1].server('postgres_changes', {type: 'insert', table: 'posts', record: {id: 9}});
  assert.deepEqual(changes, [{type: 'insert', table: 'posts', record: {id: 9}}]);
  assert.deepEqual(errors, ['token_expired']);
  assert.deepEqual(statuses, ['SUBSCRIBED', 'RECONNECTING', 'SUBSCRIBED']);

  // A dropped connection reconnects too.
  sockets[1].close();
  await until(() => sockets.length === 3, 5000);
  sockets[2].open();
  sockets[2].reply(sockets[2].join());
  await until(() => ch.state === 'joined');
  ch.unsubscribe();
  assert.equal(ch.state, 'closed');
});

test('realtime: a refused join is reported and not retried', async () => {
  const {sockets, FakeWebSocket} = fakeSockets();
  const db = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {WebSocket: FakeWebSocket, persistSession: false});
  const errors = [];
  const statuses = [];
  const ch = db.channel('changes:nope').onError((e) => errors.push(e.code)).onStatus((s) => statuses.push(s)).subscribe();
  sockets[0].open();
  sockets[0].reply(sockets[0].join(), 'error', {reason: 'table_not_exposed'});
  await assert.rejects(ch.ready(), (e) => e.code === 'table_not_exposed');
  await tick(700);
  assert.equal(sockets.length, 1);
  assert.equal(ch.state, 'refused');
  assert.deepEqual(errors, ['table_not_exposed']);
  assert.deepEqual(statuses, ['CHANNEL_ERROR']);
  ch.unsubscribe();
});

test('realtime: a refreshed session moves the channel to the new token', async () => {
  const {sockets, FakeWebSocket} = fakeSockets();
  const now = Math.floor(Date.now() / 1000);
  const fresh = jwt({exp: now + 7200, iat: now});
  const fetch = async () => new Response(JSON.stringify({access_token: fresh, refresh_token: 'r2', user: {id: 'u'}}), {status: 200});
  const db = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {
    fetch, WebSocket: FakeWebSocket, persistSession: false,
    initialSession: {access_token: jwt({exp: now + 3600, iat: now}), refresh_token: 'r1'}
  });
  const ch = db.channel('room:lobby').subscribe();
  sockets[0].open();
  sockets[0].reply(sockets[0].join());
  await ch.ready();
  await db.auth.refreshSession();
  await until(() => sockets.length === 2);
  assert.equal(sockets[1].url.searchParams.get('access_token'), fresh);
  ch.unsubscribe();
});
