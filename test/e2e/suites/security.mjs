// Every one of these must be a refusal, never data: row-level security,
// keys, origins, the secret key in a browser, injection, oversized requests,
// forged tokens and crafted filters.
import {check, refused, assert, newProject, hasControl, note, redact, PASSWORD, email} from '../lib.mjs';

// A fetch that adds headers (a browser's Origin, say) or removes the key.
const withHeaders = (extra, drop = []) => (url, init = {}) => {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  for (const k of drop) headers.delete(k);
  return fetch(url, {...init, headers});
};

export default async function security(ctx) {
  const {alice, bob, project, posts: {p1, p2, p4, p5}} = ctx;
  const totalPosts = async () => (await ctx.server.raw('SELECT count(*)::int AS n FROM posts'))[0].n;
  const before = await totalPosts();

  // ── row-level security ─────────────────────────────────────────────────
  await check('rls: another user\'s draft cannot be read, by key or by any filter', async () => {
    assert.deepEqual(await bob.db.from('posts').eq('id', p2.id), []);
    assert.deepEqual(await bob.db.from('posts').or(`id.eq.${p2.id},status.eq.draft`).neq('author_id', bob.id), []);
    assert.deepEqual(await bob.db.from('posts').eq('author_id', alice.id).eq('status', 'draft'), []);
    assert.deepEqual(await bob.db.from('posts').whereHas('comments', (c) => c.where('post_id', p2.id)), []);
    assert.deepEqual(await bob.db.from('notes').eq('owner_id', alice.id), []);
    assert.equal(await bob.db.from('notes').where('owner_id', alice.id).count(), 0);
  });

  await check('rls: another user\'s rows cannot be updated or deleted (nothing touched)', async () => {
    assert.deepEqual(await bob.db.from('posts').where('id', p1.id).update({title: 'pwned'}), []);
    assert.deepEqual(await bob.db.from('posts').where('id', p1.id).delete(), []);
    assert.equal((await alice.db.from('posts').first(p1.id)).title, 'Hello Postgres');
  });

  await check('rls: inserting as someone else is refused (403 permission_denied, 42501)', async () => {
    await refused(bob.db.from('posts').create({title: 'as alice', author_id: alice.id}), {status: 403, code: 'permission_denied', sqlstate: '42501'});
    await refused(bob.db.from('notes').create({body: 'as alice', owner_id: alice.id}), {status: 403, code: 'permission_denied'});
  });

  await check('rls: signed out cannot write or read private tables', async () => {
    await refused(ctx.anon.from('posts').create({title: 'anon'}), {status: 403, code: 'permission_denied'});
    await refused(ctx.anon.from('notes').select('*'), {status: 403, code: 'permission_denied'});
  });

  await check('rls: a table without row-level security is not exposed at all', async () => {
    await ctx.server.exec('CREATE TABLE IF NOT EXISTS internal_secrets (id int PRIMARY KEY, secret text)');
    await ctx.server.exec(`INSERT INTO internal_secrets VALUES (1, 'classified') ON CONFLICT DO NOTHING`);
    await refused(alice.db.from('internal_secrets').select('*'), {status: 404, code: 'table_not_exposed'});
    await refused(ctx.anon.from('internal_secrets').select('*'), {status: 404, code: 'table_not_exposed'});
  });

  // ── keys and origins ─────────────────────────────────────────────────────
  await check('keys: a wrong key is refused (401 invalid_api_key)', async () => {
    const wrong = ctx.client('plx_publishable_wrongwrongwrongwrong');
    await refused(wrong.from('posts').select('id'), {status: 401, code: 'invalid_api_key'});
  });

  await check('keys: a missing key is refused (401)', async () => {
    const none = ctx.client(undefined, {fetch: withHeaders({}, ['apikey'])});
    await refused(none.from('posts').select('id'), {status: 401, code: 'invalid_api_key'});
  });

  let other = null;
  if (await hasControl()) {
    other = await newProject();
    redact(other.publishable_key, other.secret_key);
    await check('keys: another project\'s keys are refused here', async () => {
      await refused(ctx.client(other.publishable_key).from('posts').select('id'), {status: 401, code: 'invalid_api_key'});
      await refused(ctx.client(other.secret_key).raw('SELECT 1'), {status: 401, code: 'invalid_api_key'});
    });
    await check('tokens: another project\'s access token is refused (401, never anon)', async () => {
      const foreign = ctx.sdk.createClient(other.api_url, other.publishable_key, {persistSession: false});
      const s = await foreign.auth.signUp({email: email('other'), password: PASSWORD});
      redact(s.access_token, s.refresh_token);
      const here = ctx.client(undefined, {initialSession: {...s, refresh_token: undefined}});
      await refused(here.from('posts').select('id'), {status: 401, code: 'invalid_access_token'});
    });
  } else {
    note('no harness control endpoint: the other-project key and token checks use forged values only');
  }

  await check('origins: the allowed origin works with the publishable key', async () => {
    const browser = ctx.client(undefined, {fetch: withHeaders({origin: project.origin})});
    const rows = await browser.from('posts').select('id').limit(1);
    assert.equal(rows.length, 1);
  });

  await check('origins: a wrong origin is refused (403 origin_denied)', async () => {
    const evil = ctx.client(undefined, {fetch: withHeaders({origin: 'https://evil.example'})});
    await refused(evil.from('posts').select('id'), {status: 403, code: 'origin_denied'});
    await refused(evil.auth.signInWithPassword({email: alice.email, password: PASSWORD}), {status: 403, code: 'origin_denied'});
  });

  await check('origins: the secret key with an Origin header is refused (403 secret_key_in_browser)', async () => {
    for (const origin of [project.origin, 'https://evil.example']) {
      const leaked = ctx.client(project.secret_key, {fetch: withHeaders({origin})});
      await refused(leaked.from('posts').select('id'), {status: 403, code: 'secret_key_in_browser'});
      await refused(leaked.raw('SELECT 1'), {status: 403, code: 'secret_key_in_browser'});
    }
  });

  await check('origins: createClient refuses the secret key in a browser before any request', async () => {
    globalThis.window = {};
    try {
      const e = await refused(Promise.resolve().then(() => ctx.sdk.createClient(project.api_url, project.secret_key)), {code: 'secret_key_in_browser'});
      assert.ok(!e.message.includes(project.secret_key));
    } finally {
      delete globalThis.window;
    }
  });

  await check('keys: the publishable key cannot run SQL (403 secret_key_required)', async () => {
    await refused(ctx.anon.sqlTransaction(['DROP TABLE posts']), {status: 403, code: 'secret_key_required'});
  });

  // ── forged tokens ──────────────────────────────────────────────────────
  await check('tokens: a tampered access token is refused (401 invalid_access_token, never anon)', async () => {
    const s = alice.db.auth.getSession();
    const [h, payload, sig] = s.access_token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = [h, Buffer.from(JSON.stringify({...claims, sub: bob.id})).toString('base64url'), sig].join('.');
    const forger = ctx.client(undefined, {initialSession: {...s, access_token: forged, refresh_token: undefined}});
    await refused(forger.from('posts').select('id'), {status: 401, code: 'invalid_access_token'});
    const unsigned = [Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'), payload, ''].join('.');
    const none = ctx.client(undefined, {initialSession: {...s, access_token: unsigned, refresh_token: undefined}});
    await refused(none.from('posts').select('id'), {status: 401, code: 'invalid_access_token'});
    const garbage = ctx.client(undefined, {initialSession: {access_token: 'not-a-token'}});
    await refused(garbage.from('posts').select('id'), {status: 401});
  });

  await check('tokens: a forged token cannot open a realtime socket either', async () => {
    const s = alice.db.auth.getSession();
    const forged = s.access_token.slice(0, -4) + (s.access_token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const errors = [];
    const sockets = [];
    class Recording extends WebSocket { constructor(...a) { super(...a); sockets.push(this); } }
    const forger = ctx.client(undefined, {WebSocket: Recording, initialSession: {access_token: forged}});
    const ch = forger.channel('changes:notes').onError((e) => errors.push(e)).subscribe();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(ch.joined, false);
    ch.unsubscribe();
  });

  // ── injection ──────────────────────────────────────────────────────────
  const evilValues = [`'; DROP TABLE posts; --`, `id) or (1=1`, `" desc; select 1; --`, `1 OR 1=1`, `\\'; select pg_sleep(5); --`];
  await check('injection: filter values are only ever values', async () => {
    for (const v of evilValues) {
      assert.deepEqual(await bob.db.from('posts').eq('title', v), []);
      assert.deepEqual(await bob.db.from('posts').in('title', [v, 'x']), []);
      assert.deepEqual(await bob.db.from('posts').ilike('title', v), []);
      assert.deepEqual(await bob.db.from('posts').whereJson('meta', 'lang.code', v), []);
      assert.deepEqual(await bob.db.from('posts').or(`title.eq."${v.replace(/"/g, '')}"`), []);
    }
  });

  await check('injection: column names, order, select items and embed names are checked, never run', async () => {
    await refused(bob.db.from('posts').where('id) or (1=1', 1), {status: 400, code: 'invalid_request'});
    await refused(bob.db.from('posts').order({column: 'likes; DROP TABLE posts', dir: 'asc'}), {status: 400});
    await refused(bob.db.from('posts').order({column: 'likes', dir: 'desc; select 1'}), {status: 400});
    await refused(bob.db.from('posts').select({column: '(select string_agg(title, \',\') from posts)', as: 'x'}), {status: 400});
    await refused(bob.db.from('posts').select('id', {embed: 'posts; DROP TABLE posts', as: 'x'}), {status: 404, code: 'table_not_exposed'});
    await refused(bob.db.from('posts; DROP TABLE posts').select('id'), {status: 404, code: 'table_not_exposed'});
    await refused(bob.db.from('posts').groupBy('status; DROP TABLE posts').aggregate({count: true}), {status: 400});
  });

  await check('injection: json paths, on_conflict and rpc arguments', async () => {
    assert.deepEqual(await bob.db.from('posts').whereJson('meta', [`lang') or ('1'='1`, 'code'], 'hi'), []);
    await refused(bob.db.from('products').upsert({sku: 'X', region: 'Y', name: 'n', price: 1}, {onConflict: ['sku; DROP TABLE products']}), {status: 400});
    assert.deepEqual((await bob.db.rpc('search_posts', {q: `'; DROP TABLE posts; --`})).data, []);
    await refused(bob.db.rpc('search_posts', {'q; DROP TABLE posts': 'x'}), {status: 400});
    await refused(bob.db.rpc('search_posts; DROP TABLE posts', {q: 'x'}), {status: 404});
  });

  await check('injection: the tables survived and nothing leaked', async () => {
    assert.equal(await totalPosts(), before);
    assert.ok(await ctx.server.migrator.hasTable('products'));
    assert.deepEqual((await bob.db.from('posts').eq('status', 'draft')).map((r) => r.id), [p5.id]);
  });

  // ── oversized requests ────────────────────────────────────────────────────
  await check('limits: a filter with more than 300 conditions is refused', async () => {
    let q = bob.db.from('posts');
    for (let i = 0; i < 301; i++) q = q.orWhere('id', i);
    await refused(q, {status: 400, code: 'invalid_request'});
  });

  await check('limits: more than 1,000 rows in one insert request is refused', async () => {
    const rows = Array.from({length: 1001}, (_, i) => ({body: `too many ${i}`}));
    await refused(bob.db.from('notes').insert(rows), {status: 400, code: 'invalid_request'});
    assert.equal(await bob.db.from('notes').like('body', 'too many %').count(), 0);
  });

  await check('limits: a huge body is refused cleanly (413)', async () => {
    await refused(bob.db.from('notes').insert({body: 'x'.repeat(6_000_000)}), {status: 413});
  });

  await check('limits: more than 1,000 rows per read is refused or capped', async () => {
    const soft = ctx.client(undefined, {throwOnError: false, initialSession: bob.db.auth.getSession()});
    const {data, error} = await soft.from('posts').limit(100000);
    if (error) assert.equal(error.status, 400);
    else assert.ok(data.length <= 1000);
  });

  if (other) {
    await check('keys: a fresh project knows nothing of this one', async () => {
      await refused(ctx.sdk.createClient(other.api_url, other.publishable_key, {persistSession: false}).from('posts').select('id'), {status: 404, code: 'table_not_exposed'});
    });
  }
}
