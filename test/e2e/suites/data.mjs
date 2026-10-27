// CRUD both ways (Supabase and GORM), every filter operator, groups, JSON
// paths, ordering with nulls, and every way to page and count.
import {check, refused, assert} from '../lib.mjs';

const titles = (rows) => rows.map((r) => r.title).sort();

export default async function data(ctx) {
  const {alice, posts: {p1, p2, p3, p4, p6}} = ctx;
  const db = alice.db;
  const posts = () => db.from('posts').select('id, title').order('id');

  // ── CRUD ────────────────────────────────────────────────────────────────
  await check('crud: create one row returns it, defaults and owner filled in', async () => {
    const note = await db.from('notes').create({body: 'first', n: 1});
    assert.ok(note.id > 0);
    assert.equal(note.owner_id, alice.id);
    assert.ok(!Number.isNaN(Date.parse(note.created_at)));
    ctx.note = note;
  });

  await check('crud: insert (Supabase) many rows, with .select()', async () => {
    const {data, error} = await db.from('notes').insert([{body: 'second', n: 2}, {body: 'third', n: 3}]).select();
    assert.equal(error, null);
    assert.deepEqual(data.map((r) => r.body), ['second', 'third']);
  });

  await check('crud: read by key: first(id), find([ids]), firstOrNull, get', async () => {
    assert.equal((await db.from('notes').first(ctx.note.id)).body, 'first');
    const rows = await db.from('notes').find([ctx.note.id]);
    assert.equal(rows.length, 1);
    assert.equal(await db.from('notes').firstOrNull(-1), null);
    assert.equal((await db.from('notes').get(ctx.note.id)).id, ctx.note.id);
    await refused(db.from('notes').first(-1), {code: 'record_not_found', status: 404});
  });

  await check('crud: update by filter returns the rows; update(id, values); increment', async () => {
    const rows = await db.from('notes').where('id', ctx.note.id).update({body: 'first, edited'});
    assert.equal(rows[0].body, 'first, edited');
    const one = await db.from('notes').update(ctx.note.id, {n: 10});
    assert.equal(one.n, 10);
    const [bumped] = await db.from('notes').where('id', ctx.note.id).increment('n', 5);
    assert.equal(bumped.n, 15);
    const {data} = await db.from('notes').update({body: 'via eq'}).eq('id', ctx.note.id).select();
    assert.equal(data[0].body, 'via eq');
  });

  await check('crud: an update or delete without a filter is refused before sending (missing_where)', async () => {
    await refused(db.from('notes').update({body: 'x'}), {code: 'missing_where'});
    await refused(db.from('notes').delete(), {code: 'missing_where'});
  });

  await check('crud: delete by filter and by key', async () => {
    const extra = await db.from('notes').create([{body: 'tmp a', n: 99}, {body: 'tmp b', n: 99}]);
    const gone = await db.from('notes').where('n', 99).delete();
    assert.equal(gone.length, 2);
    const t = await db.from('notes').create({body: 'tmp c'});
    assert.equal((await db.from('notes').delete(t.id)).id, t.id);
    assert.equal(await db.from('notes').whereIn('id', [...extra.map((r) => r.id), t.id]).count(), 0);
  });

  await check('crud: save, firstOrCreate, updateOrCreate, firstOrInit', async () => {
    const saved = await db.from('notes').save({body: 'saved', n: 7});
    const again = await db.from('notes').save({...saved, body: 'saved twice'});
    assert.equal(again.id, saved.id);
    assert.equal(again.body, 'saved twice');
    const a = await db.from('notes').firstOrCreate({body: 'unique-ish'}, {n: 1});
    const b = await db.from('notes').firstOrCreate({body: 'unique-ish'}, {n: 2});
    assert.equal(a.id, b.id);
    const c = await db.from('notes').updateOrCreate({body: 'unique-ish'}, {n: 33});
    assert.equal(c.n, 33);
    assert.deepEqual(await db.from('notes').firstOrInit({body: 'never'}, {n: 4}), {body: 'never', n: 4});
  });

  await check('crud: single, maybeSingle, sole, take, last, pluck, exists', async () => {
    const {data} = await db.from('notes').eq('id', ctx.note.id).single();
    assert.equal(data.id, ctx.note.id);
    const none = await db.from('notes').eq('id', -1).maybeSingle();
    assert.equal(none.data, null);
    await refused(db.from('notes').eq('id', -1).single(), {code: 'record_not_found'});
    await refused(db.from('notes').single(), {code: 'multiple_rows'});
    assert.equal((await db.from('notes').where('id', ctx.note.id).sole()).id, ctx.note.id);
    assert.ok(await db.from('notes').take());
    assert.ok((await db.from('notes').last()).id >= ctx.note.id);
    const bodies = await db.from('notes').whereIn('n', [2, 3]).order('n').pluck('body');
    assert.deepEqual(bodies, ['second', 'third']);
    assert.equal(await db.from('notes').where('n', 2).exists(), true);
    assert.equal(await db.from('notes').where('n', -5).exists(), false);
  });

  await check('crud: count, sum, avg, min, max', async () => {
    assert.equal(await db.from('notes').whereIn('n', [2, 3]).count(), 2);
    assert.equal(await db.from('notes').whereIn('n', [2, 3]).sum('n'), 5);
    assert.equal(await db.from('notes').whereIn('n', [2, 3]).avg('n'), 2.5);
    assert.equal(await db.from('notes').whereIn('n', [2, 3]).min('n'), 2);
    assert.equal(await db.from('notes').whereIn('n', [2, 3]).max('n'), 3);
  });

  // ── filters (alice sees p1 p2 p3 p4 p6: published, and her own draft) ────
  const filters = [
    ['eq', () => posts().eq('title', 'Hello Postgres'), [p1]],
    ['neq', () => posts().neq('status', 'published'), [p2]],
    ['gt', () => posts().gt('likes', 7), [p1, p4]],
    ['gte', () => posts().gte('likes', 7), [p1, p4, p6]],
    ['lt', () => posts().lt('likes', 5), [p2]],
    ['lte', () => posts().lte('likes', 5), [p2, p3]],
    ['like', () => posts().like('title', '%Postgres'), [p1]],
    ['ilike', () => posts().ilike('title', '%POSTGRES%'), [p1]],
    ['match (regex)', () => posts().where('title', '~', '^Bob'), [p4]],
    ['imatch (regex, any case)', () => posts().where('title', '~*', '^bob'), [p4]],
    ['in', () => posts().in('status', ['draft', 'archived']), [p2]],
    ['is null', () => posts().is('rating', null), [p2, p4]],
    ['is not null', () => posts().whereNotNull('rating'), [p1, p3, p6]],
    ['cs (array contains)', () => posts().contains('labels', ['postgres']), [p1]],
    ['cs (jsonb contains)', () => posts().contains('meta', {lang: {code: 'hi'}}), [p4]],
    ['cd (contained by)', () => posts().containedBy('labels', ['postgres', 'sql', 'extra']), [p1, p2]],
    ['ov (overlaps)', () => posts().overlaps('labels', ['cars', 'food']), [p4, p6]],
    ['fts', () => posts().textSearch('search', 'postgres & backend', {config: 'english'}), [p1]],
    ['plfts', () => posts().textSearch('search', 'fast cars', {type: 'plain', config: 'english'}), [p4]],
    ['phfts', () => posts().textSearch('search', 'slow roads', {type: 'phrase', config: 'english'}), [p4]],
    ['wfts', () => posts().textSearch('search', '"pattern matching" -cars', {type: 'websearch', config: 'english'}), [p3]],
    ['whereSearch (GORM)', () => posts().whereSearch('search', 'curry', 'english'), [p6]],
    ['not', () => posts().not('status', 'eq', 'published'), [p2]],
    ['whereNot', () => posts().whereNot('likes', '>=', 5), [p2]],
    ['or (PostgREST string)', () => posts().or('likes.gt.15,title.eq.Elixir tips'), [p3, p4]],
    ['or + and groups', () => posts().where((q) => q.where('likes', '>', 8).orWhere('labels', 'contains', ['elixir'])).where('status', 'published'), [p1, p3, p4]],
    ['nested and() inside or()', () => posts().or('and(likes.gte.5,likes.lte.7),title.eq.Hello Postgres'), [p1, p3, p6]],
    ['orWhere precedence (AND binds tighter)', () => posts().where('status', 'draft').orWhere('likes', 20), [p2, p4]],
    ['json path equality', () => posts().whereJson('meta', 'lang.code', 'hi'), [p4]],
    ['json path comparison', () => posts().whereJson('meta', ['level'], '>=', 2), [p1, p4]],
    ['match (all keys equal)', () => posts().match({status: 'published', likes: 10}), [p1]],
    ['filter (PostgREST operator)', () => posts().filter('likes', 'gte', 10), [p1, p4]],
    ['filter not.in', () => posts().filter('status', 'not.in', '(published)'), [p2]],
    ['whereBetween', () => posts().whereBetween('likes', 5, 10), [p1, p3, p6]],
    ['whereNotBetween', () => posts().whereNotBetween('likes', 5, 10), [p2, p4]],
    ['map with null and list', () => posts().where({rating: null, status: ['draft', 'published']}), [p2, p4]],
    ['dates compare as instants', () => posts().where('created_at', '>=', new Date('2026-10-04T00:00:00+05:30')), [p4, p6]]
  ];
  for (const [name, query, expected] of filters) {
    await check(`filter: ${name}`, async () => {
      const rows = await query();
      assert.deepEqual(rows.map((r) => r.id), expected.map((p) => p.id));
    });
  }

  await check('filter: values with quotes, commas and brackets are values, not syntax', async () => {
    const note = await db.from('notes').create({body: `it's "quoted", (bracketed) {braced} and a,b`});
    const rows = await db.from('notes').eq('body', `it's "quoted", (bracketed) {braced} and a,b`);
    assert.deepEqual(rows.map((r) => r.id), [note.id]);
    const via = await db.from('notes').in('body', [`it's "quoted", (bracketed) {braced} and a,b`, 'x']);
    assert.deepEqual(via.map((r) => r.id), [note.id]);
  });

  // ── ordering ───────────────────────────────────────────────────────────
  await check('order: desc with nulls first', async () => {
    const rows = await db.from('posts').select('id, rating').order('rating', 'desc', {nulls: 'first'}).order('id');
    assert.deepEqual(rows.map((r) => r.id), [p2.id, p4.id, p6.id, p1.id, p3.id]);
  });

  await check('order: Supabase form, ascending with nulls last', async () => {
    const rows = await db.from('posts').select('id, rating').order('rating', {ascending: true, nullsFirst: false}).order('id');
    assert.deepEqual(rows.map((r) => r.id), [p3.id, p1.id, p6.id, p2.id, p4.id]);
  });

  await check('order: several columns, string form, latest/oldest', async () => {
    // An enum sorts in its declared order: draft, published, archived.
    const rows = await db.from('posts').select('id, status').order('status asc').order('likes', 'desc');
    assert.deepEqual(rows.map((r) => r.id), [p2.id, p4.id, p1.id, p6.id, p3.id]);
    assert.deepEqual((await db.from('posts').latest().limit(1))[0].id, p6.id);
    assert.deepEqual((await db.from('posts').oldest().limit(1))[0].id, p1.id);
  });

  // ── paging and counting ──────────────────────────────────────────────────
  await check('paging: limit and offset', async () => {
    const rows = await posts().limit(2).offset(1);
    assert.deepEqual(rows.map((r) => r.id), [p2.id, p3.id]);
  });

  await check('paging: range (inclusive)', async () => {
    const rows = await posts().range(1, 3);
    assert.deepEqual(rows.map((r) => r.id), [p2.id, p3.id, p4.id]);
  });

  await check('paging: page(n, size)', async () => {
    const rows = await posts().page(2, 2);
    assert.deepEqual(rows.map((r) => r.id), [p3.id, p4.id]);
  });

  await check('paging: paginate with totals', async () => {
    const page = await db.from('posts').order('id').paginate({page: 3, perPage: 2});
    assert.deepEqual(page.data.map((r) => r.id), [p6.id]);
    assert.equal(page.total, 5);
    assert.equal(page.totalPages, 3);
  });

  await check('paging: exact count with rows, and head (count only)', async () => {
    const {data, count} = await db.from('posts').select('id', {count: 'exact'}).eq('status', 'published').limit(1);
    assert.equal(data.length, 1);
    assert.equal(count, 4);
    const head = await db.from('posts').select('*', {count: 'exact', head: true});
    assert.equal(head.data, null);
    assert.equal(head.count, 5);
  });

  await check('paging: findInBatches, each and for await read every row once', async () => {
    const seen = [];
    await db.from('posts').findInBatches(2, (rows) => { seen.push(...rows.map((r) => r.id)); });
    assert.deepEqual(seen, [p1.id, p2.id, p3.id, p4.id, p6.id]);
    let n = 0;
    await db.from('posts').each(() => { n++; });
    assert.equal(n, 5);
    const ids = [];
    for await (const row of db.from('posts')) ids.push(row.id);
    assert.equal(ids.length, 5);
  });

  await check('distinct values', async () => {
    const rows = await db.from('posts').select('status').distinct().order('status');
    assert.deepEqual(rows.map((r) => r.status), ['draft', 'published']);
    const on = await db.from('posts').select('author_id, likes').distinct('author_id').order('author_id').order('likes', 'desc');
    assert.equal(on.length, 3);
  });

  await check('select: aliases, ::text casts and columns', async () => {
    const [row] = await db.from('posts').select('heading:title, price::text, likes as hearts').eq('id', p1.id);
    assert.deepEqual(row, {heading: 'Hello Postgres', price: '19.9900', hearts: 10});
  });

  await check('throwOnError: false returns {data: null, error} instead of throwing', async () => {
    const soft = ctx.client(undefined, {throwOnError: false});
    const {data, error} = await soft.from('no_such_table').select('*');
    assert.equal(data, null);
    assert.equal(error.code, 'table_not_exposed');
    assert.equal(error.status, 404);
    assert.ok(error.traceId);
    const ok = await soft.from('posts').select('id').limit(1);
    assert.equal(ok.error, null);
    assert.equal(ok.data.length, 1);
  });

  await check('abortSignal: an aborted read fails with code aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await refused(db.from('posts').abortSignal(controller.signal), {code: 'aborted'});
  });
}
