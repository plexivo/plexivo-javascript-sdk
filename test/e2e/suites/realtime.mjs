// Realtime over real WebSockets: row changes under row-level security,
// filters, presence, broadcast, refused joins, reconnection after a dropped
// socket — and GraphQL queries, mutations and live queries.
import {check, refused, assert, sleep, until} from '../lib.mjs';

// A WebSocket that records every socket the SDK opens, so a test can drop one.
function recordingWebSocket() {
  const sockets = [];
  class Recording extends WebSocket {
    constructor(...args) {
      super(...args);
      sockets.push(this);
    }
  }
  return {sockets, WebSocket: Recording};
}

export default async function realtime(ctx) {
  const {alice, bob, carol} = ctx;
  const quiet = 1500;

  await check('realtime: insert, update and delete reach the owner; another user receives nothing', async () => {
    const mine = [];
    const theirs = [];
    const a = alice.db.channel('changes:notes').onChange((c) => mine.push(c)).subscribe();
    const b = bob.db.channel('changes:notes').onChange((c) => theirs.push(c)).subscribe();
    try {
      await Promise.all([a.ready(), b.ready()]);
      const note = await alice.db.from('notes').create({body: 'live', n: 7});
      await until(() => mine.some((c) => c.type === 'insert' && c.record?.id === note.id), {what: 'the insert'});
      await alice.db.from('notes').where('id', note.id).update({body: 'live, edited'});
      await until(() => mine.some((c) => c.type === 'update' && c.record?.body === 'live, edited'), {what: 'the update'});
      await alice.db.from('notes').delete(note.id);
      await until(() => mine.some((c) => c.type === 'delete'), {what: 'the delete'});
      const del = mine.find((c) => c.type === 'delete');
      assert.equal(del.old?.id ?? del.old, note.id);
      await sleep(quiet);
      assert.deepEqual(theirs, []);
    } finally {
      a.unsubscribe();
      b.unsubscribe();
    }
  });

  await check('realtime: a filter delivers only matching rows', async () => {
    const got = [];
    const ch = alice.db.channel('changes:notes', {filter: 'n=eq.4242'}).onChange((c) => got.push(c)).subscribe();
    try {
      await ch.ready();
      await alice.db.from('notes').create({body: 'not this one', n: 1});
      const wanted = await alice.db.from('notes').create({body: 'this one', n: 4242});
      await until(() => got.length > 0, {what: 'the filtered insert'});
      await sleep(500);
      assert.deepEqual(got.map((c) => c.record.id), [wanted.id]);
    } finally {
      ch.unsubscribe();
    }
  });

  await check('realtime: signed out (anon) receives published posts, never drafts', async () => {
    const got = [];
    const ch = ctx.anon.channel('changes:posts').onChange((c) => got.push(c)).subscribe();
    try {
      await ch.ready();
      await carol.db.from('posts').create({title: 'Quiet draft', status: 'draft'});
      const pub = await carol.db.from('posts').create({title: 'Loud news', status: 'published'});
      await until(() => got.some((c) => c.record?.id === pub.id), {what: 'the published post'});
      await sleep(500);
      assert.ok(got.every((c) => c.record?.status === 'published'), JSON.stringify(got.map((c) => c.record?.title)));
    } finally {
      ch.unsubscribe();
    }
  });

  await check('realtime: presence shows who is in the room, and their leaving', async () => {
    const seenByAlice = [];
    const a = alice.db.channel('room:lobby', {presence: {name: 'Alice'}}).onPresence((p) => seenByAlice.push(p)).subscribe();
    await a.ready();
    const b = bob.db.channel('room:lobby', {presence: {name: 'Bob'}}).subscribe();
    try {
      await b.ready();
      await until(() => JSON.stringify(seenByAlice).includes('Bob'), {what: 'Bob in presence'});
      assert.ok(seenByAlice.some((p) => p.event === 'presence_state'));
    } finally {
      b.unsubscribe();
    }
    await until(() => seenByAlice.some((p) => p.event === 'presence_diff' && JSON.stringify(p.state.leaves || {}).includes('Bob')), {what: 'Bob leaving'});
    a.unsubscribe();
  });

  await check('realtime: broadcast reaches others in the room', async () => {
    const got = [];
    const a = alice.db.channel('room:chat').subscribe();
    const b = bob.db.channel('room:chat').onBroadcast('message', (m) => got.push(m)).subscribe();
    try {
      await Promise.all([a.ready(), b.ready()]);
      a.sendBroadcast('message', {text: 'hello bob'});
      await until(() => got.length > 0, {what: 'the broadcast'});
      assert.deepEqual(got[0], {text: 'hello bob'});
    } finally {
      a.unsubscribe();
      b.unsubscribe();
    }
  });

  await check('realtime: a private room refuses a signed-out client, reported and not retried', async () => {
    const statuses = [];
    const {sockets, WebSocket: W} = recordingWebSocket();
    const signedOut = ctx.client(undefined, {WebSocket: W});
    const ch = signedOut.channel('room:private:staff').subscribe((s) => statuses.push(s));
    await refused(ch.ready(), {code: 'sign_in_required'});
    await sleep(1500);
    assert.equal(sockets.length, 1);
    assert.equal(ch.state, 'refused');
    assert.deepEqual(statuses, ['CHANNEL_ERROR']);
    ch.unsubscribe();
  });

  await check('realtime: an unknown table is refused (table_not_exposed)', async () => {
    const ch = alice.db.channel('changes:no_such_table').subscribe();
    await refused(ch.ready(), {code: 'table_not_exposed'});
    ch.unsubscribe();
  });

  await check('realtime: after the socket drops it reconnects and changes flow again', async () => {
    const {sockets, WebSocket: W} = recordingWebSocket();
    const db = ctx.client(undefined, {WebSocket: W, initialSession: alice.db.auth.getSession()});
    const got = [];
    const statuses = [];
    const ch = db.channel('changes:notes').onChange((c) => got.push(c)).subscribe((s) => statuses.push(s));
    try {
      await ch.ready();
      sockets[0].close();
      await until(() => statuses.includes('RECONNECTING'), {what: 'RECONNECTING'});
      await until(() => ch.state === 'joined' && sockets.length === 2, {what: 'the rejoin'});
      const note = await alice.db.from('notes').create({body: 'after the drop'});
      await until(() => got.some((c) => c.record?.id === note.id), {what: 'the change after reconnecting'});
      assert.deepEqual(statuses.filter((s) => s === 'SUBSCRIBED').length, 2);
    } finally {
      ch.unsubscribe();
    }
  });

  // ── GraphQL ────────────────────────────────────────────────────────────
  await check('graphql: a query under row-level security', async () => {
    const {data, errors} = await alice.db.graphql(`query { posts(where: { status: { eq: draft } }, orderBy: [{ id: ASC }]) { id title author_id } }`);
    assert.equal(errors, undefined);
    assert.ok(data.posts.length >= 1);
    assert.ok(data.posts.every((p) => p.author_id === alice.id));
  });

  await check('graphql: a mutation and an aggregate', async () => {
    const {data, errors} = await alice.db.graphql(`mutation($body: String!) { insertNotesOne(object: { body: $body, n: 77 }) { id body } }`, {body: 'from GraphQL'});
    assert.equal(errors, undefined, JSON.stringify(errors));
    assert.equal(data.insertNotesOne.body, 'from GraphQL');
    const agg = await alice.db.graphql(`query { notesAggregate(where: { n: { eq: 77 } }) { count } }`);
    assert.equal(agg.data.notesAggregate.count, 1);
  });

  await check('graphql: errors come back as data', async () => {
    const {data, errors} = await alice.db.graphql(`query { noSuchField { id } }`);
    assert.ok(errors?.length > 0);
    assert.ok(!data || data.noSuchField === undefined);
  });

  await check('graphql: a live query answers now and again after a change', async () => {
    const counts = [];
    const live = alice.db.graphql.subscribe(`subscription { notesAggregate(where: { n: { eq: 78 } }) { count } }`, {}, ({data}) => {
      if (data) counts.push(data.notesAggregate.count);
    });
    try {
      await until(() => counts.length > 0, {what: 'the first answer'});
      assert.equal(counts[0], 0);
      await alice.db.from('notes').create({body: 'live query', n: 78});
      await until(() => counts.includes(1), {what: 'the updated answer'});
    } finally {
      live.unsubscribe();
    }
  });
}
