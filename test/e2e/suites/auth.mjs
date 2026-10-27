// Sign-up and sign-in, user metadata, guests, devices, refresh, sign-out,
// one-time codes and recovery — and the refusals.
import {check, refused, assert, email, PASSWORD, redact} from '../lib.mjs';

export default async function auth(ctx) {
  const {alice} = ctx;

  await check('auth: sign-up returns a session with the user and user_metadata', async () => {
    assert.ok(alice.session.access_token && alice.session.refresh_token);
    assert.equal(alice.session.user.email, alice.email);
    assert.deepEqual(alice.session.user.user_metadata, {display_name: 'Alice', plan: 'pro'});
  });

  await check('auth: signUp with Supabase options.data stores user_metadata', async () => {
    const db = ctx.client();
    const s = await db.auth.signUp({email: email('opts'), password: PASSWORD, options: {data: {team: 'red'}}});
    redact(s.access_token, s.refresh_token);
    assert.deepEqual(s.user.user_metadata, {team: 'red'});
  });

  await check('auth: getUser includes user_metadata', async () => {
    const user = await alice.db.auth.getUser();
    assert.equal(user.id, alice.id);
    assert.equal(user.user_metadata.plan, 'pro');
  });

  await check('auth: updateUser merges metadata, null removes a key, the kept session follows', async () => {
    const events = [];
    const {data: {subscription}} = alice.db.auth.onAuthStateChange((e) => events.push(e));
    const user = await alice.db.auth.updateUser({data: {theme: 'dark', plan: null}});
    subscription.unsubscribe();
    assert.deepEqual(user.user_metadata, {display_name: 'Alice', theme: 'dark'});
    assert.deepEqual((await alice.db.auth.getUser()).user_metadata, {display_name: 'Alice', theme: 'dark'});
    assert.deepEqual(alice.db.auth.getSession().user.user_metadata, {display_name: 'Alice', theme: 'dark'});
    assert.deepEqual(events, ['USER_UPDATED']);
  });

  await check('auth: metadata over 4 KB is refused', async () => {
    await refused(alice.db.auth.updateUser({data: {blob: 'x'.repeat(5000)}}), {status: [400, 413, 422]});
  });

  await check('auth: signInWithPassword, SIGNED_IN event, a second device', async () => {
    const db = ctx.client();
    const events = [];
    db.auth.onAuthStateChange((e) => events.push(e));
    const s = await db.auth.signInWithPassword({email: alice.email, password: PASSWORD});
    redact(s.access_token, s.refresh_token);
    assert.equal(s.user.id, alice.id);
    assert.deepEqual(events, ['SIGNED_IN']);
    ctx.aliceSecondDevice = db;
  });

  await check('auth: a wrong password is refused (401 invalid_credentials)', async () => {
    await refused(ctx.client().auth.signInWithPassword({email: alice.email, password: 'wrong-password-1'}), {status: 401, code: 'invalid_credentials'});
  });

  await check('auth: an unknown email is refused the same way', async () => {
    await refused(ctx.client().auth.signInWithPassword({email: email('nobody'), password: PASSWORD}), {status: 401, code: 'invalid_credentials'});
  });

  await check('auth: a taken email is refused (409 email_taken)', async () => {
    await refused(ctx.client().auth.signUp({email: alice.email, password: PASSWORD}), {status: 409, code: 'email_taken'});
  });

  await check('auth: a weak password is refused', async () => {
    await refused(ctx.client().auth.signUp({email: email('weak'), password: '123'}), {status: [400, 422]});
  });

  await check('auth: sessions list both devices, current marked; revoking one ends it', async () => {
    const sessions = await alice.db.auth.listSessions();
    assert.ok(sessions.length >= 2, `sessions: ${sessions.length}`);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    const other = (await ctx.aliceSecondDevice.auth.listSessions()).find((s) => s.current);
    await alice.db.auth.revokeSession(other.id);
    await refused(ctx.aliceSecondDevice.auth.refreshSession(), {status: 401});
    assert.ok(!(await alice.db.auth.listSessions()).some((s) => s.id === other.id));
  });

  await check('auth: refreshSession issues new tokens and TOKEN_REFRESHED', async () => {
    const db = ctx.client();
    const first = await db.auth.signInWithPassword({email: alice.email, password: PASSWORD});
    redact(first.access_token, first.refresh_token);
    const events = [];
    db.auth.onAuthStateChange((e, s) => { events.push(e); if (s) redact(s.access_token, s.refresh_token); });
    const next = await db.auth.refreshSession();
    assert.notEqual(next.refresh_token, first.refresh_token);
    assert.equal(next.user.id, alice.id);
    assert.deepEqual(events, ['TOKEN_REFRESHED']);
    assert.equal((await db.auth.getUser()).id, alice.id);
    await db.auth.signOut();
  });

  await check('auth: sign-out forgets the session; signed-in calls then need a user', async () => {
    const db = ctx.client();
    await db.auth.signInWithPassword({email: alice.email, password: PASSWORD});
    const refresh = db.auth.getSession().refresh_token;
    await db.auth.signOut();
    assert.equal(db.auth.getSession(), null);
    await refused(db.auth.getUser(), {code: 'sign_in_required'});
    await refused(ctx.client().auth.refreshSession(refresh), {status: 401});
    // Signed out, the publishable key reads as anon: only published posts.
    const rows = await db.from('posts').select('title, status');
    assert.ok(rows.length > 0 && rows.every((r) => r.status === 'published'));
  });

  await check('auth: a guest keeps its id and rows when it becomes an account', async () => {
    const db = ctx.client();
    const guest = await db.auth.signInAnonymously();
    redact(guest.access_token, guest.refresh_token);
    assert.equal(guest.user.is_anonymous, true);
    const note = await db.from('notes').create({body: 'written as a guest'});
    const upgraded = await db.auth.linkEmail({email: email('guest'), password: PASSWORD});
    redact(upgraded.access_token, upgraded.refresh_token);
    assert.equal(upgraded.user.id, guest.user.id);
    assert.equal(upgraded.user.is_anonymous, false);
    assert.equal((await db.from('notes').first(note.id)).body, 'written as a guest');
  });

  await check('auth: one-time code requested; a wrong code is refused', async () => {
    const address = email('otp');
    const db = ctx.client();
    await db.auth.signInWithOtp({email: address});
    await refused(db.auth.verifyOtp({email: address, token: '000000'}), {status: 401, code: 'invalid_passwordless_code'});
    assert.equal(db.auth.getSession(), null);
  });

  await check('auth: password recovery requested; a wrong code is refused', async () => {
    const db = ctx.client();
    await db.auth.resetPasswordForEmail(alice.email);
    await refused(db.auth.verifyPasswordRecovery({email: alice.email, code: '000000', newPassword: 'another-Strong-pass-7'}), {status: 401, code: 'invalid_recovery_code'});
    await ctx.client().auth.signInWithPassword({email: alice.email, password: PASSWORD});
  });

  await check('auth: providers list answers', async () => {
    const providers = await ctx.anon.auth.getProviders();
    assert.equal(typeof providers, 'object');
  });

  await check('auth: OAuth sign-in builds a PKCE URL with the publishable key only', async () => {
    const {url, codeVerifier} = await ctx.client().auth.signInWithOAuth({provider: 'github', redirectTo: 'https://app.example/callback', skipBrowserRedirect: true});
    const u = new URL(url);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(codeVerifier.length >= 43);
    assert.ok(u.searchParams.get('apikey').startsWith('plx_publishable_'));
  });
}
