// Upserts, bulk writes past 1,000 rows, transactions with references and
// rollback, and database functions (scalar, set-returning with a query on
// the result, RETURNS TABLE, void).
import {check, refused, assert} from '../lib.mjs';

export default async function writes(ctx) {
  const {alice, bob, posts: {p1, p2, p3, p4, p6}} = ctx;
  const db = alice.db;

  // ── upsert ─────────────────────────────────────────────────────────────
  await check('upsert merge on a composite key (on_conflict sku, region)', async () => {
    await db.from('products').upsert([{sku: 'MUG', region: 'IN', name: 'Mug', price: '4.50', stock: 10}, {sku: 'MUG', region: 'GB', name: 'Mug', price: '5.00', stock: 3}], {onConflict: ['sku', 'region']});
    const {data} = await db.from('products').upsert({sku: 'MUG', region: 'IN', name: 'Mug (blue)', price: '4.75', stock: 12}, {onConflict: 'sku,region'});
    assert.equal(data.length, 1);
    const {data: row} = await db.from('products').match({sku: 'MUG', region: 'IN'}).select('name, price::text, stock').single();
    assert.deepEqual(row, {name: 'Mug (blue)', price: '4.75', stock: 12});
    assert.equal(await db.from('products').where('sku', 'MUG').count(), 2);
  });

  await check('upsert with chosen update columns leaves the others alone', async () => {
    await db.from('products').upsert({sku: 'MUG', region: 'IN', name: 'ignored', price: '99.00', stock: 1}, {onConflict: ['sku', 'region'], update: ['stock']});
    const {data: row} = await db.from('products').match({sku: 'MUG', region: 'IN'}).select('name, price::text, stock').single();
    assert.deepEqual(row, {name: 'Mug (blue)', price: '4.75', stock: 1});
  });

  await check('upsert ignore (ignoreDuplicates) keeps the existing row and inserts new ones', async () => {
    const {data} = await db.from('products').upsert([
      {sku: 'MUG', region: 'IN', name: 'nope', price: '0', stock: 0},
      {sku: 'CAP', region: 'IN', name: 'Cap', price: '9.99', stock: 5}
    ], {onConflict: ['sku', 'region'], ignoreDuplicates: true});
    assert.deepEqual(data.map((r) => r.sku), ['CAP']);
    assert.equal((await db.from('products').match({sku: 'MUG', region: 'IN'}).single()).data.name, 'Mug (blue)');
  });

  await check('save (GORM): insert, then update by primary key', async () => {
    const t = await db.from('tags').save({name: 'saved-tag'});
    assert.ok(t.id);
  });

  await check('a unique violation is a typed error (409 unique_violation, SQLSTATE 23505)', async () => {
    const e = await refused(db.from('tags').create({name: 'postgres'}), {status: 409, code: 'unique_violation', sqlstate: '23505'});
    assert.ok(e.traceId);
    assert.ok(ctx.sdk.isUniqueViolation(e));
  });

  await check('check, not-null, foreign-key and invalid-value errors are typed', async () => {
    await refused(db.from('posts').create({title: ''}), {status: 400, code: 'check_violation', sqlstate: '23514'});
    await refused(db.from('comments').create({post_id: p1.id, body: null}), {status: 400, code: 'not_null_violation', sqlstate: '23502'});
    await refused(db.from('posts').create({title: 'Orphan editor', editor_id: '00000000-0000-4000-8000-000000000000'}), {status: 409, code: 'foreign_key_violation', sqlstate: '23503'});
    await refused(db.from('posts').create({title: 'Bad enum', status: 'deleted'}), {status: 400, sqlstate: '22P02'});
  });

  // ── bulk ───────────────────────────────────────────────────────────────
  await check('bulk insert of 2,500 rows (create batches by 1,000), count, update and delete them', async () => {
    const rows = Array.from({length: 2500}, (_, i) => ({body: `bulk ${i}`, n: 100000 + i}));
    const created = await db.from('notes').create(rows);
    assert.equal(created.length, 2500);
    assert.equal(await db.from('notes').where('n', '>=', 100000).count(), 2500);
    const updated = await db.from('notes').where('n', '>=', 100000).where('n', '<', 101000).update({body: 'bulk updated'}, undefined, {returning: 'minimal'});
    assert.equal(updated.count, 1000);
    assert.equal(await db.from('notes').where('body', 'bulk updated').count(), 1000);
    const gone = await db.from('notes').where('n', '>=', 100000).delete({returning: 'minimal'});
    assert.equal(gone.count, 2500);
    assert.equal(await db.from('notes').where('n', '>=', 100000).count(), 0);
  });

  await check('createInBatches inserts in chosen batch sizes', async () => {
    const out = await db.from('notes').createInBatches(Array.from({length: 250}, (_, i) => ({body: `batch ${i}`, n: 200000})), 100);
    assert.equal(out.length, 250);
    const {count} = await db.from('notes').where('n', 200000).delete({returning: 'minimal'});
    assert.equal(count, 250);
  });

  // ── transactions ───────────────────────────────────────────────────────
  await check('transaction: a post, its comment by reference, a tag link and a function call commit together', async () => {
    const [post, comment, , sum] = await db.transaction((tx) => {
      const post = tx.from('posts').create({title: 'Written in a transaction', status: 'published'});
      tx.from('comments').create({post_id: post.ref('id'), body: 'First!'});
      tx.from('post_tags').create({post_id: post.ref('id'), tag_id: ctx.tags.sql.id});
      tx.rpc('add_numbers', {a: 20, b: 22});
    });
    assert.equal(comment.post_id, post.id);
    assert.equal(sum.data, 42);
    const [row] = await db.from('posts').select('title, comments(body), post_tags(tags(name))').eq('id', post.id);
    assert.deepEqual(row.comments, [{body: 'First!'}]);
    ctx.txPost = post;
  });

  await check('transaction: a failing step rolls every step back and names it', async () => {
    const before = await db.from('posts').count();
    const e = await refused(db.transaction((tx) => {
      tx.from('posts').create({title: 'Never committed'});
      tx.from('posts').create({title: ''});
    }), {code: 'check_violation'});
    assert.equal(e.operation, 1);
    assert.equal(await db.from('posts').count(), before);
    assert.equal(await db.from('posts').where('title', 'Never committed').count(), 0);
  });

  await check('transaction: a row lock and a counter in one request', async () => {
    const results = await db.transaction((tx) => {
      tx.from('products').where({sku: 'CAP', region: 'IN'}).lockForUpdate().find();
      tx.from('products').where({sku: 'CAP', region: 'IN'}).decrement('stock', 2);
    });
    assert.equal(results[1][0].stock, 3);
  });

  await check('transaction: row-level security still applies inside (another user\'s rows untouched)', async () => {
    const [rows] = await db.transaction((tx) => { tx.from('posts').where('id', p4.id).update({title: 'hijacked'}); });
    assert.equal(rows.length, 0);
    assert.equal((await bob.db.from('posts').first(p4.id)).title, 'Bob on cars');
  });

  // ── functions ──────────────────────────────────────────────────────────
  await check('rpc: a scalar function', async () => {
    const {data, error} = await db.rpc('add_numbers', {a: 2, b: 3});
    assert.equal(error, null);
    assert.equal(data, 5);
  });

  await check('rpc: runs as the caller (auth.uid())', async () => {
    assert.equal((await db.rpc('whoami')).data, alice.id);
    assert.equal((await ctx.anon.rpc('whoami')).data, null);
  });

  await check('rpc: a set-returning function, plain', async () => {
    const {data} = await db.rpc('search_posts', {q: 'cars'});
    assert.deepEqual(data.map((r) => r.id), [p4.id]);
  });

  await check('rpc: a set-returning function under row-level security (drafts stay private)', async () => {
    const {data} = await bob.db.rpc('search_posts', {q: 'secrets'});
    assert.deepEqual(data, []);
  });

  await check('rpc: query the result: select, filter, order, range and an exact count', async () => {
    const {data, count} = await db.rpc('search_posts', {q: 'o'}, {count: 'exact'})
      .select('id, title')
      .eq('status', 'published')
      .order('likes', {ascending: false})
      .range(0, 1);
    assert.deepEqual(data.map((r) => r.id), [p4.id, p1.id]);
    assert.ok(count >= 4, `count ${count}`);
    assert.deepEqual(Object.keys(data[0]).sort(), ['id', 'title']);
  });

  await check('rpc: embeds through the returned table\'s foreign keys', async () => {
    const {data} = await db.rpc('search_posts', {q: 'Elixir'}).select('title, author:profiles!posts_author_id_fkey(username), comments(body)');
    assert.deepEqual(data, [{title: 'Elixir tips', author: {username: 'alice'}, comments: [{body: 'Nice tips'}]}]);
  });

  await check('rpc: single and maybeSingle', async () => {
    const {data} = await db.rpc('search_posts', {q: 'Carol'}).select('title').single();
    assert.deepEqual(data, {title: 'Carol cooks'});
    const none = await db.rpc('search_posts', {q: 'zzzz'}).select('title').maybeSingle();
    assert.equal(none.data, null);
    await refused(db.rpc('search_posts', {q: 'o'}).select('id').single(), {code: 'multiple_rows'});
  });

  await check('rpc: RETURNS TABLE with filters and order', async () => {
    const {data} = await db.rpc('author_stats', {min_likes: 1}).gte('total_likes', 7).order('total_likes', {ascending: false});
    assert.deepEqual(data.map((r) => [r.author, Number(r.posts), Number(r.total_likes)]), [['bob', 1, 20], ['alice', 2, 15], ['carol', 1, 7]].filter(([, , l]) => l >= 7));
  });

  await check('rpc: a void function', async () => {
    const before = (await db.from('posts').first(p3.id)).likes;
    const {data} = await db.rpc('like_post', {post_id: p3.id});
    assert.equal(data, null);
    assert.equal((await db.from('posts').first(p3.id)).likes, before + 1);
  });

  await check('rpc: an unexposed function, an unknown function and a wrong argument are refused', async () => {
    await refused(db.rpc('not_exposed'), {status: 404, code: 'function_not_exposed'});
    await refused(db.rpc('no_such_function'), {status: 404, code: 'function_not_exposed'});
    await refused(db.rpc('add_numbers', {a: 1, c: 2}), {status: 400});
    await refused(db.rpc('add_numbers', {a: 'one', b: 2}), {status: 400});
  });
}
