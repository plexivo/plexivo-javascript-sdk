// Many users at once through the connection pooler: each sees only their
// own rows, and `auth.uid()` is always the caller (no session state bleeds
// between pooled connections).
import {check, assert} from '../lib.mjs';
import {newUser} from '../seed.mjs';

const USERS = 20;
const PER_USER = 25;

export default async function concurrency(ctx) {
  let users = [];
  await check(`concurrency: ${USERS} users sign up and write their own rows in parallel`, async () => {
    users = await Promise.all(Array.from({length: USERS}, (_, i) => newUser(ctx, `load${i}x${Date.now().toString(36)}`)));
    await Promise.all(users.map((u, i) => u.db.from('notes').create([{body: `secret of ${u.id}`, n: i}, {body: `second secret of ${u.id}`, n: i}])));
  });
  if (users.length !== USERS) return;

  await check(`concurrency: ${USERS * PER_USER} parallel requests, each user sees only their own rows`, async () => {
    const requests = [];
    for (const u of users) {
      for (let j = 0; j < PER_USER; j++) {
        const kind = j % 5;
        requests.push((async () => {
          if (kind === 0) {
            const rows = await u.db.from('notes').select('owner_id, body');
            assert.ok(rows.length >= 2 && rows.every((r) => r.owner_id === u.id), `user ${u.id} saw ${rows.length} rows, owners ${[...new Set(rows.map((r) => r.owner_id))].length}`);
          } else if (kind === 1) {
            assert.equal((await u.db.rpc('whoami')).data, u.id);
          } else if (kind === 2) {
            assert.equal(await u.db.from('notes').count(), 2);
          } else if (kind === 3) {
            const {data} = await u.db.from('notes').eq('owner_id', u.id).single().catch(() => ({data: 'many'}));
            assert.equal(data, 'many');
          } else {
            const [[row]] = await u.db.transaction((tx) => { tx.from('notes').select('n').limit(1).find(); });
            assert.equal(typeof row.n, 'number');
          }
        })());
      }
    }
    const settled = await Promise.allSettled(requests);
    const failed = settled.filter((s) => s.status === 'rejected');
    const byCode = {};
    for (const f of failed) {
      const key = `${f.reason?.status ?? '-'} ${f.reason?.code ?? f.reason?.message}`;
      byCode[key] = (byCode[key] || 0) + 1;
    }
    assert.equal(failed.length, 0, `${failed.length} of ${requests.length} failed: ${JSON.stringify(byCode)}; first trace ${failed.find((f) => f.reason?.traceId)?.reason?.traceId ?? '-'}`);
  });

  await check('concurrency: parallel writes and reads interleaved stay isolated', async () => {
    await Promise.all(users.map(async (u, i) => {
      for (let k = 0; k < 3; k++) {
        await u.db.from('notes').create({body: `burst ${k}`, n: 1000 + i});
        const mine = await u.db.from('notes').where('n', 1000 + i).pluck('body');
        assert.equal(mine.length, k + 1);
      }
    }));
    const others = await users[0].db.from('notes').where('n', '>=', 1001).count();
    assert.equal(others, 0);
  });
}
