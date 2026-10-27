// Joins of every kind, GORM-style and Supabase-style side by side: embeds
// (many-to-one, one-to-many, many-to-many, nested), inner and left joins,
// hints, whereHas, aggregates, a view with joins, related order and
// subqueries.
import {check, refused, assert} from '../lib.mjs';
import {belongsTo, hasMany, manyToMany} from './models.mjs';

export default async function relations(ctx) {
  const {alice, bob, posts: {p1, p2, p3, p4, p6}} = ctx;
  const db = alice.db;

  // A GORM-style client for alice: models said once.
  const orm = ctx.client(undefined, {initialSession: db.auth.getSession()});
  const {Post} = defineModels(ctx, orm);

  // ── many-to-one ────────────────────────────────────────────────────────
  await check('embed many-to-one (Supabase): author:profiles!fk(…)', async () => {
    const [row] = await db.from('posts').select('title, author:profiles!posts_author_id_fkey(username, country)').eq('id', p1.id);
    assert.deepEqual(row, {title: 'Hello Postgres', author: {username: 'alice', country: 'IN'}});
  });

  await check('embed many-to-one (GORM): preload a belongsTo relation', async () => {
    const post = await Post.query().preload('author', (a) => a.select('username')).first(p3.id);
    assert.deepEqual(post.author, {username: 'alice'});
  });

  await check('embed: two foreign keys to one table need a hint; without one it is refused clearly', async () => {
    const e = await refused(db.from('posts').select('title, profiles(username)'), {status: 400, code: 'invalid_request'});
    assert.match(e.message, /more than one way/);
    const rows = await db.from('posts').select('id, editor:profiles!posts_editor_id_fkey(username)').order('id');
    assert.equal(rows.find((r) => r.id === p3.id).editor.username, 'bob');
    assert.equal(rows.find((r) => r.id === p1.id).editor, null);
  });

  // ── one-to-many ────────────────────────────────────────────────────────
  await check('embed one-to-many (Supabase): comments(body)', async () => {
    const [row] = await db.from('posts').select('title, comments(body)').eq('id', p1.id);
    assert.deepEqual(row.comments.map((c) => c.body).sort(), ['Great post', 'Spam?', 'Thanks!']);
  });

  await check('embed one-to-many (GORM): preload hasMany, left join keeps posts without comments', async () => {
    const rows = await Post.query().preload('comments').order('id');
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.find((r) => r.id === p2.id).comments, []);
    assert.equal(rows.find((r) => r.id === p1.id).comments.length, 3);
  });

  // ── many-to-many ───────────────────────────────────────────────────────
  await check('embed many-to-many (Supabase): through the link table', async () => {
    const [row] = await db.from('posts').select('title, post_tags(tags(name))').eq('id', p1.id);
    assert.deepEqual(row.post_tags.map((l) => l.tags.name).sort(), ['postgres', 'sql']);
  });

  await check('embed many-to-many (GORM): preload a manyToMany relation, ordered', async () => {
    const post = await Post.query().preload('tags', (t) => t.order('name', 'desc')).first(p1.id);
    assert.deepEqual(post.tags.map((t) => t.name), ['sql', 'postgres']);
    const none = await Post.query().preload('tags').first(p2.id);
    assert.deepEqual(none.tags, []);
  });

  await check('association mode: count, find, append and delete links (many-to-many)', async () => {
    assert.equal(await Post.association(p3, 'tags').count(), 1);
    await Post.association(p3, 'tags').append([ctx.tags.postgres]);
    assert.deepEqual((await Post.association(p3, 'tags').find()).map((t) => t.name).sort(), ['elixir', 'postgres']);
    await Post.association(p3, 'tags').delete([ctx.tags.postgres]);
    assert.equal(await Post.association(p3, 'tags').count(), 1);
  });

  // ── nested ─────────────────────────────────────────────────────────────
  await check('embed nested 3 deep (Supabase): posts → comments → profiles → posts', async () => {
    const [row] = await db.from('posts')
      .select('title, comments(body, profiles(username, posts!posts_author_id_fkey(title)))')
      .eq('id', p3.id);
    const [comment] = row.comments;
    assert.equal(comment.profiles.username, 'bob');
    assert.deepEqual(comment.profiles.posts.map((p) => p.title), ['Bob on cars']);
  });

  await check('preload by path (GORM Preload("Comments.Author.Posts"))', async () => {
    const post = await Post.query().preload('comments.author.posts', (q) => q.select('title')).first(p3.id);
    assert.equal(post.comments[0].author.username, 'bob');
    assert.deepEqual(post.comments[0].author.posts, [{title: 'Bob on cars'}]);
    const merged = await Post.query().preload('comments', (c) => c.where('approved', true)).preload('comments.author').first(p1.id);
    assert.equal(merged.comments.length, 2);
    assert.ok(merged.comments.every((c) => typeof c.author.username === 'string'));
  });

  // ── filtered, ordered and limited embeds ─────────────────────────────────
  await check('embed filtered + ordered + limited (GORM preload callback)', async () => {
    const post = await Post.query().preload('comments', (c) => c.where('approved', true).order('id', 'desc').limit(1)).first(p1.id);
    assert.deepEqual(post.comments.map((c) => c.body), ['Thanks!']);
  });

  await check('embed ordered + limited (Supabase referencedTable)', async () => {
    const [row] = await db.from('posts').select('id, comments(body, approved)')
      .eq('id', p1.id)
      .order('id', {referencedTable: 'comments', ascending: false})
      .limit(2, {referencedTable: 'comments'});
    assert.deepEqual(row.comments.map((c) => c.body), ['Spam?', 'Thanks!']);
  });

  // ── inner joins, whereHas ──────────────────────────────────────────────
  await check('inner join (Supabase !inner): only posts with comments', async () => {
    const rows = await db.from('posts').select('id, comments!inner(body)').order('id');
    assert.deepEqual(rows.map((r) => r.id), [p1.id, p3.id, p4.id]);
  });

  await check('inner join (GORM joins with a condition)', async () => {
    const rows = await Post.query().joins('comments', (c) => c.where('body', 'Vroom')).order('id');
    assert.deepEqual(rows.map((r) => r.id), [p4.id]);
    assert.deepEqual(rows[0].comments.map((c) => c.body), ['Vroom']);
  });

  await check('whereHas / orWhereHas / whereDoesntHave', async () => {
    assert.deepEqual((await db.from('posts').whereHas('comments', (c) => c.where('approved', false)).order('id')).map((r) => r.id), [p1.id]);
    assert.deepEqual((await db.from('posts').whereDoesntHave('comments').order('id')).map((r) => r.id), [p2.id, p6.id]);
    assert.deepEqual((await db.from('posts').where('likes', 7).orWhereHas('comments', (c) => c.where('body', 'Vroom')).order('id')).map((r) => r.id), [p4.id, p6.id]);
    assert.deepEqual((await Post.whereHas('tags', (t) => t.where('name', 'elixir'))).map((r) => r.id), [p3.id]);
  });

  // ── aggregates ─────────────────────────────────────────────────────────
  await check('aggregates: count, sum, avg, min, max of visible rows', async () => {
    const q = db.from('posts');
    assert.equal(await q.count(), 5);
    assert.equal(await q.sum('likes'), 42);
    assert.equal(await q.avg('likes'), 8.4);
    assert.equal(await q.min('likes'), 0);
    assert.equal(await q.max('likes'), 20);
    const all = await q.aggregate({count: true, sum: ['likes'], max: ['likes']});
    assert.equal(Number(all.count), 5);
  });

  await check('aggregates: groupBy with sums, having, order by an aggregate', async () => {
    const groups = await db.from('posts').groupBy('status').order('status').aggregate({count: true, sum: ['likes']});
    assert.deepEqual(groups.map((g) => [g.status, Number(g.count), Number(g.sum.likes)]), [['draft', 1, 0], ['published', 4, 42]]);
    const busy = await db.from('posts').groupBy('author_id').having('count', '>', 1).aggregate({count: true});
    assert.deepEqual(busy.map((g) => g.author_id), [alice.id]);
    const top = await db.from('posts').groupBy('author_id').order('count(*)', 'desc').limit(1).aggregate({count: true});
    assert.equal(top[0].author_id, alice.id);
    const sumHaving = await db.from('posts').groupBy('author_id').having('sum(likes) >= ?', 20).order('author_id').aggregate({sum: ['likes']});
    assert.equal(sumHaving.length, 1);
  });

  await check('aggregates of related rows: withCount, comments(count), withAggregate', async () => {
    const post = await db.from('posts').withCount('comments').where('id', p1.id).first();
    assert.equal(post.comments_count, 3);
    const [row] = await db.from('posts').select('id, comments(count)').eq('id', p1.id);
    const n = Array.isArray(row.comments) ? row.comments[0]?.count : row.comments?.count;
    assert.equal(Number(n), 3);
    const profile = await db.from('profiles').withAggregate('posts!posts_author_id_fkey', {count: true, sum: ['likes']}, undefined, 'stats').where('id', alice.id).first();
    assert.equal(Number(profile.stats.count), 3);
    assert.equal(Number(profile.stats.sum.likes), 15);
  });

  // ── a view with joins: the raw-join path for browsers ─────────────────────
  await check('view with joins (security_invoker): each caller sees what their policies allow', async () => {
    const mine = await db.from('post_feed').select('*').order('id');
    assert.deepEqual(mine.map((r) => r.id), [p1.id, p2.id, p3.id, p4.id, p6.id]);
    const first = mine[0];
    assert.equal(first.author, 'alice');
    assert.equal(Number(first.comment_count), 3);
    assert.deepEqual(first.tag_names, ['postgres', 'sql']);
    const public_ = await ctx.anon.from('post_feed').select('id, status').order('id');
    assert.deepEqual(public_.map((r) => r.id), [p1.id, p3.id, p4.id, p6.id]);
    const bobs = await bob.db.from('post_feed').select('id').order('id');
    assert.ok(!bobs.some((r) => r.id === p2.id));
    const filtered = await db.from('post_feed').select('title, author').eq('author', 'bob').gte('likes', 10);
    assert.deepEqual(filtered, [{title: 'Bob on cars', author: 'bob'}]);
  });

  // ── order by a related row's column ──────────────────────────────────────
  await check('related order: dotted relation.column with a hint', async () => {
    const rows = await db.from('posts').select('id').order('profiles.username', 'desc', {hint: 'posts_author_id_fkey'}).order('id');
    assert.deepEqual(rows.map((r) => r.id), [p6.id, p4.id, p1.id, p2.id, p3.id]);
  });

  await check('related order: GORM model relation (Joins("Author").Order("Author.username"))', async () => {
    const rows = await Post.query().select('id').order('author.username').order('id');
    assert.deepEqual(rows.map((r) => r.id), [p1.id, p2.id, p3.id, p4.id, p6.id]);
  });

  await check('related order: {relation} with nulls last, and a to-many relation is refused', async () => {
    const rows = await db.from('posts').select('id').order('username', {relation: 'profiles', hint: 'posts_editor_id_fkey', ascending: true, nullsFirst: false}).order('id');
    assert.equal(rows[0].id, p3.id);
    await refused(db.from('posts').order('comments.body'), {status: 400, code: 'invalid_request'});
  });

  // ── subqueries ─────────────────────────────────────────────────────────
  await check('subquery: whereIn(column, query) and whereNotIn', async () => {
    const indian = db.from('profiles').select('id').where('country', 'IN');
    assert.deepEqual((await db.from('posts').whereIn('author_id', indian).order('id')).map((r) => r.id), [p1.id, p2.id, p3.id, p6.id]);
    assert.deepEqual((await db.from('posts').whereNotIn('author_id', indian).order('id')).map((r) => r.id), [p4.id]);
    assert.deepEqual((await db.from('posts').in('author_id', indian).eq('likes', 7)).map((r) => r.id), [p6.id]);
  });

  await check('subquery: runs under its own table\'s row-level security', async () => {
    const owners = (client) => client.from('profiles').whereIn('id', client.from('notes').select('owner_id')).pluck('username');
    assert.deepEqual(await owners(db), ['alice']);
    assert.deepEqual(await owners(bob.db), []);
  });
}

function defineModels(ctx, orm) {
  const Post = orm.model('posts', {
    relations: {
      author: belongsTo('profiles', {foreignKey: 'author_id', constraint: 'posts_author_id_fkey'}),
      editor: belongsTo('profiles', {foreignKey: 'editor_id', constraint: 'posts_editor_id_fkey'}),
      comments: hasMany('comments', {foreignKey: 'post_id'}),
      tags: manyToMany('tags', {through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id'})
    }
  });
  orm.model('comments', {relations: {author: belongsTo('profiles', {foreignKey: 'author_id'}), post: belongsTo('posts', {foreignKey: 'post_id'})}});
  orm.model('profiles', {relations: {posts: hasMany('posts', {foreignKey: 'author_id', constraint: 'posts_author_id_fkey'})}});
  return {Post};
}
