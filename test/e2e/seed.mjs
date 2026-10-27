// The rows every suite reads, written by the users themselves under
// row-level security (the secret key only created the schema).
import {email, PASSWORD, redact} from './lib.mjs';

/** A signed-in user with a profile. */
export async function newUser(ctx, username, {country = null, data} = {}) {
  const db = ctx.client();
  const address = email(username);
  const session = await db.auth.signUp({email: address, password: PASSWORD, ...(data ? {data} : {})});
  redact(session.access_token, session.refresh_token);
  db.auth.onAuthStateChange((_event, s) => s && redact(s.access_token, s.refresh_token));
  const profile = await db.from('profiles').create({username, country});
  return {db, id: session.user.id, email: address, profile, session};
}

export async function seed(ctx) {
  const alice = await newUser(ctx, 'alice', {country: 'IN', data: {display_name: 'Alice', plan: 'pro'}});
  const bob = await newUser(ctx, 'bob', {country: 'GB'});
  const carol = await newUser(ctx, 'carol', {country: 'IN'});
  Object.assign(ctx, {alice, bob, carol});

  const [p1, p2, p3] = await alice.db.from('posts').create([
    {title: 'Hello Postgres', body: 'Row level security makes Postgres a backend', status: 'published', likes: 10,
      price: '19.9900', rating: 4.5, labels: ['postgres', 'sql'], scores: [1, 2, 3],
      meta: {lang: {code: 'en'}, level: 2, flags: ['a']}, published_on: '2026-10-01', created_at: '2026-10-01T09:00:00Z'},
    {title: 'Draft secrets', body: 'Not for anyone else', status: 'draft', likes: 0, created_at: '2026-10-02T09:00:00Z'},
    {title: 'Elixir tips', body: 'Pattern matching and processes', status: 'published', likes: 5, rating: 3,
      editor_id: bob.id, labels: ['elixir'], meta: {lang: {code: 'en'}, level: 1}, created_at: '2026-10-03T09:00:00Z'}
  ]);
  const [p4, p5] = await bob.db.from('posts').create([
    {title: 'Bob on cars', body: 'Fast cars and slow roads', status: 'published', likes: 20, labels: ['cars'],
      meta: {lang: {code: 'hi'}, level: 3}, created_at: '2026-10-04T09:00:00Z'},
    {title: 'Bob draft', body: 'Private thoughts', status: 'draft', created_at: '2026-10-05T09:00:00Z'}
  ]);
  const p6 = await carol.db.from('posts').create({title: 'Carol cooks', body: 'Curry and rice', status: 'published', likes: 7,
    rating: 5, labels: ['food', 'india'], meta: {lang: {code: 'ta'}, level: 1}, created_at: '2026-10-06T09:00:00Z'});
  ctx.posts = {p1, p2, p3, p4, p5, p6};

  const tags = await alice.db.from('tags').create([{name: 'postgres'}, {name: 'sql'}, {name: 'elixir'}]);
  const cars = await bob.db.from('tags').create({name: 'cars'});
  ctx.tags = Object.fromEntries([...tags, cars].map((t) => [t.name, t]));
  await alice.db.from('post_tags').create([
    {post_id: p1.id, tag_id: ctx.tags.postgres.id},
    {post_id: p1.id, tag_id: ctx.tags.sql.id},
    {post_id: p3.id, tag_id: ctx.tags.elixir.id}
  ]);
  await bob.db.from('post_tags').create({post_id: p4.id, tag_id: cars.id});

  await alice.db.from('comments').create([{post_id: p1.id, body: 'Great post', approved: true}, {post_id: p4.id, body: 'Vroom', approved: true}]);
  await bob.db.from('comments').create([{post_id: p1.id, body: 'Thanks!', approved: true}, {post_id: p3.id, body: 'Nice tips', approved: true}]);
  await carol.db.from('comments').create({post_id: p1.id, body: 'Spam?', approved: false});
}
