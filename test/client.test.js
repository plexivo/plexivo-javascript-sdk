import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../src/index.js';
import {renderTypes} from '../src/generate-types.js';

test('function invocations preserve encoded paths and query values on the project origin', async () => {
  const calls = [];
  const client = createClient('https://api.example/client/v1/project', 'plx_publishable_test', {
    fetch: async (url, init) => { calls.push({url, init}); return new Response('{"ok":true}', {headers: {'content-type': 'application/json'}}); }
  });
  await client.functions.invoke('echo', {path: '/some folder/part?x=1', query: {q: 'a & b', n: 2, flag: false, absent: null}, body: {hello: 'world'}});
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://api.example');
  assert.equal(url.pathname, '/client/v1/project/functions/v1/echo/some%20folder/part%3Fx%3D1');
  assert.equal(url.searchParams.get('q'), 'a & b');
  assert.equal(url.searchParams.get('n'), '2');
  assert.equal(url.searchParams.get('flag'), 'false');
  assert.equal(url.searchParams.has('absent'), false);
  assert.equal(calls[0].init.body, '{"hello":"world"}');
  await assert.rejects(client.functions.invoke('echo', {path: '../other'}), TypeError);
  assert.equal(calls.length, 1);
});

test('uses the publishable key and app-user access token', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({access_token: 'access', refresh_token: 'refresh'}), {
        status: 200,
        headers: {'x-trace-id': 'trace-login'}
      });
    }
    return new Response(JSON.stringify({data: [{id: 'one'}]}), {status: 200});
  };
  const client = createClient('https://api.example/client/v1/demo/', 'plx_publishable_test', {fetch});
  await client.auth.signInWithPassword({email: 'app@example.com', password: 'long-password'});
  assert.deepEqual(await client.from('items').select(), [{id: 'one'}]);
  assert.equal(calls[0].init.headers.get('apikey'), 'plx_publishable_test');
  assert.equal(calls[1].init.headers.get('authorization'), 'Bearer access');
  assert.equal(client.lastTraceId, null);
});

test('surfaces the trace id on failed API calls without inventing a request id', async () => {
  const fetch = async () => new Response(
    JSON.stringify({error: {code: 'invalid_credentials'}, trace_id: 'trace-failure'}),
    {status: 401, headers: {'x-trace-id': 'trace-failure'}}
  );
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch});

  await assert.rejects(
    client.auth.signInWithPassword({email: 'app@example.com', password: 'long-password'}),
    (error) => {
      assert.equal(error.code, 'invalid_credentials');
      assert.equal(error.traceId, 'trace-failure');
      assert.equal('requestId' in error, false);
      return true;
    }
  );
  assert.equal(client.lastTraceId, 'trace-failure');
});

test('never sends a platform or database credential', async () => {
  const fetch = async (_url, init) => {
    const headers = Object.fromEntries(init.headers.entries());
    assert.deepEqual(Object.keys(headers).sort(), ['apikey', 'content-type']);
    return new Response(JSON.stringify({access_token: 'access', refresh_token: 'refresh'}), {status: 200});
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch});
  await client.auth.signUp({email: 'app@example.com', password: 'long-password'});
});

test('persists sessions, refreshes an expired access token once, and emits auth events', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const events = [];
  let itemCalls = 0;
  const fetch = async (url, init) => {
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({access_token: 'expired', refresh_token: 'refresh'}), {status: 200});
    }
    if (url.endsWith('/auth/refresh')) {
      return new Response(JSON.stringify({access_token: 'fresh', refresh_token: 'rotated'}), {status: 200});
    }
    if (url.endsWith('/query/v1')) {
      itemCalls += 1;
      if (itemCalls === 1) {
        return new Response(JSON.stringify({error: {code: 'token_expired'}}), {status: 401});
      }
      assert.equal(init.headers.get('authorization'), 'Bearer fresh');
      return new Response(JSON.stringify({data: [{id: 'one'}]}), {status: 200});
    }
    throw new Error(`unexpected call ${url}`);
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, storage});
  client.auth.onAuthStateChange((event) => events.push(event));

  await client.auth.signInWithPassword({email: 'app@example.com', password: 'long-password'});
  assert.deepEqual(await client.from('items').select(), [{id: 'one'}]);
  assert.equal(client.auth.getSession().access_token, 'fresh');
  assert.deepEqual(events, ['SIGNED_IN', 'TOKEN_REFRESHED']);

  const restored = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, storage});
  assert.equal(restored.auth.getSession().refresh_token, 'rotated');
});

test('server-side sign out revokes the refresh session before clearing local state', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({access_token: 'access', refresh_token: 'refresh'}), {status: 200});
    }
    if (url.endsWith('/auth/logout')) return new Response(null, {status: 204});
    throw new Error(`unexpected call ${url}`);
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, persistSession: false});
  await client.auth.signInWithPassword({email: 'app@example.com', password: 'long-password'});
  await client.auth.signOut();

  assert.equal(client.auth.getSession(), null);
  assert.equal(calls[1].init.headers.get('authorization'), 'Bearer access');
  assert.deepEqual(JSON.parse(calls[1].init.body), {refresh_token: 'refresh'});
});

test('coalesces concurrent expired-token retries into one refresh rotation', async () => {
  let refreshCalls = 0;
  let expiredCalls = 0;
  const fetch = async (url, init) => {
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({access_token: 'expired', refresh_token: 'refresh'}), {status: 200});
    }
    if (url.endsWith('/auth/refresh')) {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({access_token: 'fresh', refresh_token: 'rotated'}), {status: 200});
    }
    if (url.endsWith('/query/v1')) {
      if (init.headers.get('authorization') === 'Bearer expired') {
        expiredCalls += 1;
        return new Response(JSON.stringify({error: {code: 'token_expired'}}), {status: 401});
      }
      return new Response(JSON.stringify({data: []}), {status: 200});
    }
    throw new Error(`unexpected call ${url}`);
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, persistSession: false});
  await client.auth.signInWithPassword({email: 'app@example.com', password: 'long-password'});

  await Promise.all([client.from('items').select(), client.from('items').select()]);
  assert.equal(expiredCalls, 2);
  assert.equal(refreshCalls, 1);
});

test('exposes password recovery, passwordless OTP and only configured provider metadata', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, body: init.body && JSON.parse(init.body)});
    if (url.endsWith('/auth/providers')) {
      return new Response(JSON.stringify({providers: [], password: {enabled: true}, passwordless_email: {enabled: true, delivery: 'otp'}}), {status: 200});
    }
    if (url.endsWith('/auth/passwordless/verify')) {
      return new Response(JSON.stringify({access_token: 'otp-access', refresh_token: 'otp-refresh'}), {status: 200});
    }
    if (url.endsWith('/auth/password/reset')) return new Response(null, {status: 204});
    return new Response(JSON.stringify({accepted: true}), {status: 202});
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, persistSession: false});

  assert.deepEqual((await client.auth.getProviders()).providers, []);
  await client.auth.resetPasswordForEmail('app@example.com');
  await client.auth.verifyPasswordRecovery({email: 'app@example.com', code: '12345678', newPassword: 'new-password'});
  await client.auth.signInWithOtp({email: 'app@example.com'});
  await client.auth.verifyOtp({email: 'app@example.com', token: '87654321'});

  assert.equal(client.auth.getSession().access_token, 'otp-access');
  assert.deepEqual(calls.map(({body}) => body), [undefined, {email: 'app@example.com'}, {email: 'app@example.com', code: '12345678', new_password: 'new-password'}, {email: 'app@example.com'}, {email: 'app@example.com', code: '87654321'}]);
});

test('handles user-scoped broadcast and presence frames', async () => {
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      this.handlers = new Map();
      this.frames = [];
      sockets.push(this);
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    send(frame) { this.frames.push(JSON.parse(frame)); }
    close() { this.readyState = 3; }
    emit(name, data) { this.handlers.get(name)?.(data); }
  }
  const broadcasts = [];
  const presences = [];
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {
    WebSocket: FakeWebSocket,
    initialSession: {access_token: 'access', refresh_token: 'refresh'},
    persistSession: false,
    realtimeClientId: 'browser-one'
  });
  const channel = client.channel('items')
    .onBroadcast('cursor.move', (payload) => broadcasts.push(payload))
    .onPresence((update) => presences.push(update))
    .subscribe();

  sockets[0].emit('open', {});
  channel.sendBroadcast('cursor.move', {x: 2});
  sockets[0].emit('message', {data: JSON.stringify([null, null, 'realtime:items', 'broadcast', {event: 'cursor.move', payload: {x: 4}}])});
  sockets[0].emit('message', {data: JSON.stringify([null, null, 'realtime:items', 'presence_state', {user: {metas: []}}])});

  assert.equal(sockets[0].frames[0][3], 'phx_join');
  assert.deepEqual(sockets[0].frames[0][4], {client_id: 'browser-one'});
  assert.equal(sockets[0].frames[1][3], 'broadcast');
  assert.deepEqual(broadcasts, [{x: 4}]);
  assert.equal(presences[0].event, 'presence_state');
  channel.unsubscribe();
});

test('fetches the versioned schema with only a publishable key', async () => {
  const fetch = async (url, init) => {
    assert.match(url, /\/meta\/schema$/);
    assert.equal(init.headers.get('apikey'), 'plx_publishable_test');
    assert.equal(init.headers.has('authorization'), false);
    return new Response(JSON.stringify({version: '1', schema: 'public', tables: {items: {}}}), {status: 200});
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch});
  assert.equal((await client.getSchema()).version, '1');
});

test('renders deterministic typed starter table definitions', () => {
  const generated = renderTypes({
    version: '2026-09-13',
    schema: 'public',
    tables: {
      items: {
        row: [{name: 'id', type: 'string', nullable: false}],
        insert: [{name: 'key', type: 'string', nullable: false}, {name: 'value', type: 'json', nullable: true}],
        update: [{name: 'key', type: 'string', nullable: false}]
      }
    }
  });
  assert.match(generated, /interface Database/);
  assert.match(generated, /id: string/);
  assert.match(generated, /value\?: Json \| null/);
});

test('storage upload uses auth only to mint a short-lived URL and never sends project credentials to object bytes', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({access_token: 'access', refresh_token: 'refresh'}), {status: 200});
    }
    if (url.endsWith('/storage/v1/objects/sign-upload')) {
      assert.deepEqual(JSON.parse(init.body), {
        path: 'avatars/me.png',
        content_type: 'image/png',
        size: 3
      });
      return new Response(JSON.stringify({data: {
        object: {id: 'object-one', path: 'avatars/me.png', status: 'pending'},
        signed_url: 'https://api.example/client-storage/v1/demo/objects/object-one?token=signed'
      }}), {status: 201});
    }
    if (url.includes('/client-storage/v1/')) {
      assert.deepEqual(init.headers, {'content-type': 'image/png'});
      assert.equal(init.body.byteLength, 3);
      return new Response(JSON.stringify({data: {
        id: 'object-one', path: 'avatars/me.png', status: 'ready'
      }}), {status: 200, headers: {'x-trace-id': 'trace-upload'}});
    }
    throw new Error(`unexpected call ${url}`);
  };

  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, persistSession: false});
  await client.auth.signInWithPassword({email: 'app@example.com', password: 'long-password'});
  const object = await client.storage.upload('avatars/me.png', new Uint8Array([1, 2, 3]), {contentType: 'image/png'});

  assert.equal(object.id, 'object-one');
  assert.equal(calls[1].init.headers.get('apikey'), 'plx_publishable_test');
  assert.equal(calls[1].init.headers.get('authorization'), 'Bearer access');
  assert.equal(client.lastTraceId, 'trace-upload');
});

test('a non-JSON error page still fails as a PlexivoError with its status', async () => {
  const {PlexivoError} = await import('../src/index.js');
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {
    fetch: async () => new Response('<html>Bad gateway</html>', {status: 502, headers: {'content-type': 'text/html', 'x-trace-id': 'trace-502'}})
  });
  await assert.rejects(client.from('notes').select(), (error) => {
    assert.ok(error instanceof PlexivoError);
    assert.equal(error.status, 502);
    assert.equal(error.traceId, 'trace-502');
    return true;
  });
});

test('signed storage transfers fail as PlexivoError', async () => {
  const {PlexivoError} = await import('../src/index.js');
  const fetch = async (url) => {
    if (url.endsWith('/auth/login')) return new Response(JSON.stringify({access_token: 'a', refresh_token: 'r'}));
    if (url.endsWith('/sign-download')) return new Response(JSON.stringify({data: {signed_url: 'https://files.example/o/1?sig=x'}}));
    return new Response(JSON.stringify({error: {code: 'signature_expired', message: 'expired'}}), {status: 403});
  };
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {fetch, persistSession: false});
  await client.auth.signInWithPassword({email: 'a@example.com', password: 'long-password'});
  await assert.rejects(client.storage.download('1'), (error) => {
    assert.ok(error instanceof PlexivoError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'signature_expired');
    return true;
  });
});

test('single() and sole() refuse several rows with a PlexivoError', async () => {
  const {PlexivoError} = await import('../src/index.js');
  const client = createClient('https://api.example/client/v1/demo', 'plx_publishable_test', {
    fetch: async () => new Response(JSON.stringify({data: [{id: 1}, {id: 2}], count: 2}))
  });
  for (const run of [() => client.from('notes').select().single(), () => client.from('notes').sole()]) {
    await assert.rejects(run(), (error) => {
      assert.ok(error instanceof PlexivoError);
      assert.equal(error.code, 'multiple_rows');
      assert.equal(error.status, 406);
      return true;
    });
  }
});

test('plexivo-generate-types writes types for the live Data API, not the old starter table', async () => {
  const {createServer} = await import('node:http');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({url: req.url, apikey: req.headers.apikey});
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      mode: 'rls',
      tables: [{name: 'todos', kind: 'table', writable: true, primary_key: ['id'], comment: null, foreign_keys: [], columns: [
        {name: 'id', type: 'bigint', not_null: true, has_default: true, read_only: false, comment: null},
        {name: 'title', type: 'text', not_null: true, has_default: false, read_only: false, comment: null},
        {name: 'done', type: 'boolean', not_null: true, has_default: true, read_only: false, comment: null}
      ]}],
      functions: []
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/client/v1/demo`;
  try {
    const {stdout} = await promisify(execFile)(process.execPath, [new URL('../scripts/generate-types.mjs', import.meta.url).pathname, '--url', url, '--key', 'plx_publishable_test']);
    assert.equal(seen[0].url, '/client/v1/demo/meta/api');
    assert.equal(seen[0].apikey, 'plx_publishable_test');
    assert.match(stdout, /todos: \{/);
    assert.match(stdout, /title: string;/);
    assert.doesNotMatch(stdout, /items:/);
  } finally {
    server.close();
  }
});
