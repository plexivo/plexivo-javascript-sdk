import {apiError, PlexivoError, RecordNotFoundError, isNotFound, isUniqueViolation, isPermissionDenied} from './errors.js';
import {QueryBuilder, Conditions} from './query.js';
import {tableContext, defineModel, belongsTo, hasOne, hasMany, manyToMany} from './model.js';
import {sqlApi} from './sql.js';

export {PlexivoError, RecordNotFoundError, isNotFound, isUniqueViolation, isPermissionDenied, belongsTo, hasOne, hasMany, manyToMany, QueryBuilder, Conditions};

const trimSlash = (value) => value.replace(/\/+$/, '');

export function createClient(apiUrl, publishableKey, options = {}) {
  if (!apiUrl || !publishableKey) throw new Error('apiUrl and publishableKey are required');

  const baseUrl = trimSlash(apiUrl);
  const request = options.fetch || globalThis.fetch;
  if (!request) throw new Error('A Fetch API implementation is required');

  const storage = options.storage || (typeof window !== 'undefined' ? window.localStorage : null);
  const storageKey = options.storageKey || `plexivo-client:${baseUrl}:session`;
  const persistSession = options.persistSession !== false;
  const authListeners = new Set();
  let session = options.initialSession || readStoredSession();
  let lastTraceId = null;
  let refreshPromise = null;

  function readStoredSession() {
    if (!persistSession || !storage) return null;
    try {
      return JSON.parse(storage.getItem(storageKey) || 'null');
    } catch {
      return null;
    }
  }

  function setSession(nextSession, event) {
    session = nextSession;
    if (persistSession && storage) {
      try {
        if (nextSession) storage.setItem(storageKey, JSON.stringify(nextSession));
        else storage.removeItem(storageKey);
      } catch {
        // A blocked browser store must not turn a valid server session into an auth failure.
      }
    }
    for (const listener of authListeners) {
      try {
        listener(event, session);
      } catch {
        // Application listeners are isolated from the SDK session state.
      }
    }
  }

  function refreshExpiredSession() {
    if (!refreshPromise) {
      refreshPromise = call(
        '/auth/refresh',
        {method: 'POST', body: JSON.stringify({refresh_token: session?.refresh_token})},
        false,
        false
      ).then((refreshed) => {
        setSession(refreshed, 'TOKEN_REFRESHED');
        return refreshed;
      }).finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  // `authenticated`: true requires a signed-in user; 'optional' sends the
  // user's token when there is one (the Data API then runs as that user,
  // otherwise as the key: anon for the publishable key, service_role for the secret key).
  async function call(path, init = {}, authenticated = false, allowRefresh = true) {
    const headers = new Headers(init.headers || {});
    headers.set('apikey', publishableKey);
    headers.set('content-type', 'application/json');
    if (authenticated === true && !session?.access_token) throw new Error('An authenticated application user is required');
    const sendToken = authenticated && session?.access_token;
    if (sendToken) {
      headers.set('authorization', `Bearer ${session.access_token}`);
    }

    const response = await request(`${baseUrl}${path}`, {...init, headers});
    lastTraceId = response.headers.get('x-trace-id');
    const payload = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (
        sendToken &&
        allowRefresh &&
        response.status === 401 &&
        payload?.error?.code === 'token_expired' &&
        session?.refresh_token
      ) {
        await refreshExpiredSession();
        return call(path, init, authenticated, false);
      }
      throw apiError(response, payload, lastTraceId);
    }
    return payload;
  }

  async function authenticate(path, credentials) {
    const nextSession = await call(path, {method: 'POST', body: JSON.stringify(credentials)});
    setSession(nextSession, path === '/auth/signup' ? 'SIGNED_UP' : path === '/auth/refresh' ? 'TOKEN_REFRESHED' : 'SIGNED_IN');
    return nextSession;
  }

  const auth = {
    signUp: (credentials) => authenticate('/auth/signup', credentials),
    signInWithPassword: (credentials) => authenticate('/auth/login', credentials),
    getProviders: () => call('/auth/providers'),
    resetPasswordForEmail: (email) => call('/auth/password/recovery', {
      method: 'POST', body: JSON.stringify({email})
    }),
    verifyPasswordRecovery: ({email, code, newPassword}) => call('/auth/password/reset', {
      method: 'POST', body: JSON.stringify({email, code, new_password: newPassword})
    }),
    signInWithOtp: ({email}) => call('/auth/passwordless', {
      method: 'POST', body: JSON.stringify({email})
    }),
    async verifyOtp({email, token, mfaCode}) {
      const nextSession = await call('/auth/passwordless/verify', {
        method: 'POST',
        body: JSON.stringify({email, code: token, ...(mfaCode ? {mfa_code: mfaCode} : {})})
      });
      setSession(nextSession, 'SIGNED_IN');
      return nextSession;
    },
    async refreshSession(refreshToken = session?.refresh_token) {
      if (!refreshToken) throw new Error('A refresh token is required');
      return authenticate('/auth/refresh', {refresh_token: refreshToken});
    },
    getSession: () => session,
    getUser: () => call('/auth/user', {}, true).then((result) => result.user),
    async updatePassword({currentPassword, newPassword}) {
      await call('/auth/password', {
        method: 'POST',
        body: JSON.stringify({current_password: currentPassword, new_password: newPassword})
      }, true);
      setSession(null, 'PASSWORD_RECOVERY');
    },
    async deleteUser({password}) {
      await call('/auth/user', {method: 'DELETE', body: JSON.stringify({password})}, true);
      setSession(null, 'USER_DELETED');
    },
    async signOut({scope = 'local'} = {}) {
      try {
        await call('/auth/logout', {
          method: 'POST',
          body: JSON.stringify(scope === 'global' ? {} : {refresh_token: session?.refresh_token})
        }, true, false);
      } finally {
        setSession(null, 'SIGNED_OUT');
      }
    },
    onAuthStateChange(listener) {
      authListeners.add(listener);
      return {data: {subscription: {unsubscribe: () => authListeners.delete(listener)}}};
    },
    /** A guest session, when the project allows guests; upgrade it later with linkEmail. */
    async signInAnonymously() {
      const nextSession = await call('/auth/anonymous', {method: 'POST', body: '{}'});
      setSession(nextSession, 'SIGNED_IN');
      return nextSession;
    },
    /** The guest becomes an account with this email and password, keeping its id and rows. */
    async linkEmail({email, password}) {
      const nextSession = await call('/auth/upgrade', {method: 'POST', body: JSON.stringify({email, password})}, true);
      setSession(nextSession, 'USER_UPDATED');
      return nextSession;
    },
    /**
     * Sign in with Google, GitHub or Microsoft (OAuth with PKCE). Returns the
     * URL to send the browser to and the verifier to keep for
     * exchangeCodeForSession; in a browser it is kept for you.
     */
    async signInWithOAuth({provider, redirectTo, skipBrowserRedirect = false}) {
      const verifier = randomVerifier();
      const challenge = await pkceChallenge(verifier);
      const url = new URL(`${baseUrl}/auth/oauth/${encodeURIComponent(provider)}/authorize`);
      url.searchParams.set('redirect_to', redirectTo || (typeof window !== 'undefined' ? window.location.href : ''));
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('apikey', publishableKey);
      try { storage?.setItem(`${storageKey}:pkce`, verifier); } catch { /* no store */ }
      if (!skipBrowserRedirect && typeof window !== 'undefined' && window.location) window.location.assign(url.toString());
      return {url: url.toString(), codeVerifier: verifier};
    },
    /** Completes OAuth: the `code` from the redirect, and the verifier (kept for you in a browser). */
    async exchangeCodeForSession(code, codeVerifier) {
      let verifier = codeVerifier;
      if (!verifier) { try { verifier = storage?.getItem(`${storageKey}:pkce`); } catch { verifier = null; } }
      if (!verifier) throw new Error('The PKCE code verifier from signInWithOAuth is required');
      const nextSession = await call('/auth/oauth/token', {method: 'POST', body: JSON.stringify({code, code_verifier: verifier})});
      try { storage?.removeItem(`${storageKey}:pkce`); } catch { /* no store */ }
      setSession(nextSession, 'SIGNED_IN');
      return nextSession;
    },
    /** The user's signed-in devices; `current` marks this one. */
    listSessions: () => call('/auth/sessions', {}, true).then((r) => r.sessions),
    getSessions: () => call('/auth/sessions', {}, true).then((r) => r.sessions),
    revokeSession: (sessionId) => call(`/auth/sessions/${encodeURIComponent(sessionId)}`, {method: 'DELETE'}, true),
    /** Organisations for your app's own users: roles, members and invitations. */
    orgs: {
      list: () => call('/auth/orgs', {}, true).then((r) => r.data),
      create: ({name, slug, metadata}) => call('/auth/orgs', {method: 'POST', body: JSON.stringify({name, slug, metadata})}, true).then((r) => r.data),
      delete: (orgId) => call(`/auth/orgs/${encodeURIComponent(orgId)}`, {method: 'DELETE'}, true),
      members: (orgId) => call(`/auth/orgs/${encodeURIComponent(orgId)}/members`, {}, true).then((r) => r.data),
      setRole: (orgId, userId, role) => call(`/auth/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {method: 'PATCH', body: JSON.stringify({role})}, true).then((r) => r?.data),
      removeMember: (orgId, userId) => call(`/auth/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {method: 'DELETE'}, true),
      invitations: (orgId) => call(`/auth/orgs/${encodeURIComponent(orgId)}/invitations`, {}, true).then((r) => r.data),
      invite: (orgId, {email, role = 'member'}) => call(`/auth/orgs/${encodeURIComponent(orgId)}/invitations`, {method: 'POST', body: JSON.stringify({email, role})}, true).then((r) => r.data),
      revokeInvitation: (orgId, invitationId) => call(`/auth/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`, {method: 'DELETE'}, true),
      accept: (token) => call('/auth/invitations/accept', {method: 'POST', body: JSON.stringify({token})}, true).then((r) => r.data),
      acceptInvitation: (token) => call('/auth/invitations/accept', {method: 'POST', body: JSON.stringify({token})}, true).then((r) => r.data)
    },
    /** Server-only, with the secret key: bring users over with their password hashes. */
    admin: {
      importFromSupabase: () => call('/auth/admin/import/supabase', {method: 'POST', body: '{}'}),
      importUsers: (users) => call('/auth/admin/import', {method: 'POST', body: JSON.stringify({users})})
    },
    mfa: {
      enroll: () => call('/auth/mfa/totp/enroll', {method: 'POST', body: '{}'}, true).then((result) => result.factor),
      verify: ({code}) => call('/auth/mfa/totp/verify', {method: 'POST', body: JSON.stringify({code})}, true).then((result) => result.factor),
      unenroll: ({password}) => call('/auth/mfa/totp', {method: 'DELETE', body: JSON.stringify({password})}, true)
    }
  };

  const getSchema = () => call('/meta/schema');
  /** The live Data API: every exposed table (columns, keys, relations) and function. */
  const getApi = () => call('/meta/api', {}, 'optional');

  function bodySize(body) {
    if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
    throw new TypeError('Storage upload body must be a string, Blob, ArrayBuffer, or typed array');
  }

  async function signedRequest(url, init) {
    const response = await request(url, init);
    lastTraceId = response.headers.get('x-trace-id');
    if (!response.ok) {
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      const error = new Error(payload?.error?.code || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error?.code;
      error.traceId = payload?.trace_id || lastTraceId;
      throw error;
    }
    return response;
  }

  const objectStorage = {
    list: () => call('/storage/v1/objects', {}, true).then((result) => result.data),
    async upload(path, body, {contentType} = {}) {
      if (!contentType) throw new TypeError('contentType is required');
      const signed = await call('/storage/v1/objects/sign-upload', {
        method: 'POST',
        body: JSON.stringify({path, content_type: contentType, size: bodySize(body)})
      }, true).then((result) => result.data);

      const uploaded = await signedRequest(signed.signed_url, {
        method: 'PUT',
        headers: {'content-type': contentType},
        body
      });
      return (await uploaded.json()).data;
    },
    createSignedDownloadUrl: (id) =>
      call(`/storage/v1/objects/${encodeURIComponent(id)}/sign-download`, {method: 'POST'}, true)
        .then((result) => result.data),
    async download(id) {
      const signed = await objectStorage.createSignedDownloadUrl(id);
      const response = await signedRequest(signed.signed_url, {method: 'GET'});
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type')
      };
    },
    remove: (id) => call(`/storage/v1/objects/${encodeURIComponent(id)}`, {method: 'DELETE'}, true)
  };

  // ── the data layer: query builder, models, transactions ────────────────

  const models = new Map();

  function dataLayer(send) {
    const layer = {
      _send: send,
      _query: (op) => send(() => op, (r) => r, 'raw'),
      _model: (table) => models.get(table),
      /** A query on one table: chain filters, then await it (find) or call a terminal method. */
      from(table) {
        if (typeof table !== 'string' || !table) throw new TypeError('from() takes a table name');
        const model = models.get(table);
        return new QueryBuilder(tableContext(layer, table, model ? {...model} : {}));
      }
    };
    layer.table = layer.from;
    layer.transaction = (callback) => transaction(callback);
    return layer;
  }

  const direct = dataLayer((build, finish) =>
    Promise.resolve().then(build).then((op) => call('/query/v1', {method: 'POST', body: JSON.stringify(op)}, 'optional')).then(finish));

  /**
   * Several operations that commit together or not at all. Record them on
   * `tx` without awaiting; later ones can use earlier results with `.ref()`:
   *
   *   const [author, post] = await db.transaction((tx) => {
   *     const author = tx.from('authors').create({name: 'Asha'});
   *     tx.from('posts').create({title: 'Hello', author_id: author.ref('id')});
   *   });
   *
   * A row lock (`lockForUpdate()`) on a select holds until the transaction commits.
   */
  async function transaction(callback) {
    const slots = [];
    let building = 0;
    let sent = false;

    const send = (build, finish, shape) => {
      if (sent) {
        throw new PlexivoError(
          'This transaction was already sent. Record every operation before awaiting any of them, and use .ref() to pass one result to the next.',
          {code: 'transaction_already_sent'}
        );
      }
      const index = slots.length;
      let resolve, reject;
      const handle = new Promise((res, rej) => { resolve = res; reject = rej; });
      handle.catch(() => {});
      const prefix = shape === 'row' || shape === 'rows' ? 'data.0.' : 'data.';
      handle.ref = (path = '') => ({$ref: `${index}.${path === '' ? prefix.slice(0, -1) : prefix + path}`});
      handle.refAll = (path = '') => ({$ref: `${index}.data${path ? '.' + path : ''}`});
      building++;
      const slot = {op: null, finish, resolve, reject};
      slot.ready = Promise.resolve().then(build).then((op) => { slot.op = op; }).finally(() => { building--; });
      slots.push(slot);
      return handle;
    };

    const tx = dataLayer(send);
    tx._deferred = true;
    let settled = false, failure;
    const running = Promise.resolve().then(() => callback(tx)).then(
      () => { settled = true; },
      (e) => { settled = true; failure = e; }
    );

    // Wait until the callback is done, or is waiting on one of its own operations.
    for (;;) {
      const before = slots.length;
      await new Promise((r) => setTimeout(r, 0));
      if (settled) break;
      if (slots.length > 0 && slots.length === before && building === 0) break;
    }
    if (failure) throw failure;
    if (slots.length === 0) return [];

    await Promise.all(slots.map((s) => s.ready));
    sent = true;
    let results;
    try {
      results = (await call('/query/v1/transaction', {method: 'POST', body: JSON.stringify({operations: slots.map((s) => s.op)})}, 'optional')).results;
    } catch (error) {
      for (const s of slots) s.reject(error);
      throw error;
    }
    const finished = [];
    for (let i = 0; i < slots.length; i++) {
      try {
        const value = await slots[i].finish(results[i]);
        slots[i].resolve(value);
        finished.push(value);
      } catch (error) {
        slots[i].reject(error);
        throw error;
      }
    }
    await running;
    if (failure) throw failure;
    return finished;
  }

  /** Calls a database function exposed with COMMENT ON FUNCTION … IS '@expose'. */
  const rpc = (fn, args = {}) => call(`/rest/v1/rpc/${encodeURIComponent(fn)}`, {method: 'POST', body: JSON.stringify(args)}, 'optional')
    .then((r) => ({data: r.data, count: r.count ?? null, error: null}));

  /**
   * A GraphQL query or mutation on your schema: `{data, errors}`, errors as
   * data the way GraphQL returns them. `{persisted: true}` sends only the
   * query's hash after the first time (automatic persisted queries).
   */
  async function graphql(query, variables = {}, options = {}) {
    const opts = typeof options === 'string' ? {operationName: options} : options;
    const base = {variables, ...(opts.operationName ? {operationName: opts.operationName} : {})};
    const post = (body) => call('/graphql/v1', {method: 'POST', body: JSON.stringify(body)}, 'optional')
      .catch((e) => (e.status === 400 && e.details === undefined ? Promise.reject(e) : Promise.reject(e)));
    if (!opts.persisted) return post({query, ...base});
    const sha256Hash = await sha256Hex(query);
    const extensions = {persistedQuery: {version: 1, sha256Hash}};
    const first = await post({...base, extensions});
    if (first?.errors?.some((e) => e.message === 'PersistedQueryNotFound' || e.extensions?.code === 'PERSISTED_QUERY_NOT_FOUND')) {
      return post({query, ...base, extensions});
    }
    return first;
  }
  /** A live query: `onResult` gets the answer now, and again whenever a row it reads changes. */
  graphql.subscribe = (query, variables = {}, onResult) => {
    const id = `q${Math.random().toString(36).slice(2, 10)}`;
    const ch = channel('graphql');
    ch._onGraphql(id, onResult);
    ch._onJoin(() => ch._push('subscribe', {id, query, variables}).then((reply) => {
      if (reply.status !== 'ok') onResult({errors: reply.response?.errors || [{message: reply.response?.reason || 'subscribe failed'}]});
    }));
    ch.subscribe();
    return {unsubscribe: () => { ch._push('unsubscribe', {id}).catch(() => {}); ch.unsubscribe(); }};
  };

  /** Plexivo Functions: your server-side code beside the data. */
  const functions = {
    async invoke(name, {body, method = 'POST', headers = {}} = {}) {
      const h = new Headers(headers);
      h.set('apikey', publishableKey);
      if (session?.access_token) h.set('authorization', `Bearer ${session.access_token}`);
      const isJson = body !== undefined && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(typeof Blob !== 'undefined' && body instanceof Blob);
      if (isJson && !h.has('content-type')) h.set('content-type', 'application/json');
      const response = await request(`${baseUrl}/functions/v1/${encodeURIComponent(name)}`, {method, headers: h, body: isJson ? JSON.stringify(body) : body});
      lastTraceId = response.headers.get('x-trace-id');
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await response.json() : await response.text();
      if (!response.ok) throw apiError(response, typeof data === 'object' ? data : null, lastTraceId);
      return {data, status: response.status, headers: response.headers};
    }
  };

  // The 0.1 table client stays: from(t).select(), insert(v), get(id), update(id, v), delete(id).
  function from(table) {
    const q = direct.from(table);
    q.get = (id, ...more) => (id === undefined ? q.find() : more.length ? q.find([id, ...more]) : q.first(id).catch((e) => {
      if (e instanceof RecordNotFoundError) throw Object.assign(new PlexivoError('not found', {status: 404, code: 'not_found'}), {});
      throw e;
    }));
    return q;
  }

  /**
   * Realtime. Topics:
   *   'changes:<table>'  row changes you may read, with an optional filter
   *                      (`channel('changes:orders', {filter: 'status=eq.open'})`);
   *   'room:<name>'      broadcast and presence for everyone who joins
   *                      ('room:private:…' for signed-in users only);
   *   '<table>'          the original per-user starter channel ('items').
   * Works signed out too, where the rows or room allow it.
   */
  function channel(topic = 'items', channelOptions = {}) {
    const full = /^(changes|room):/.test(topic) || topic === 'graphql' ? `realtime:${topic}` : `realtime:${topic}`;
    const listeners = new Set();
    const broadcastListeners = new Map();
    const presenceListeners = new Set();
    const graphqlListeners = new Map();
    const joinCallbacks = [];
    const replies = new Map();
    let socket;
    let heartbeat;
    let reconnectTimer;
    let reconnectAttempt = 0;
    let active = false;
    let joined = false;
    let ref = 1;

    const clearTimers = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      heartbeat = null;
      reconnectTimer = null;
    };

    const send = (event, payload, topicName = full) => {
      if (!socket || socket.readyState !== 1) return null;
      const r = String(ref++);
      socket.send(JSON.stringify(['1', r, topicName, event, payload]));
      return r;
    };
    const push = (event, payload) => new Promise((resolve, reject) => {
      const r = send(event, payload);
      if (!r) return reject(new Error('Realtime channel is not connected'));
      replies.set(r, resolve);
      setTimeout(() => { if (replies.delete(r)) reject(new Error('Realtime reply timed out')); }, 10_000);
    });

    const connect = () => {
      const parsed = new URL(baseUrl);
      const project = parsed.pathname.split('/').filter(Boolean).at(-1);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      const socketUrl = new URL(`${protocol}//${parsed.host}/client-data/socket/websocket`);
      socketUrl.searchParams.set('vsn', '2.0.0');
      socketUrl.searchParams.set('project', project);
      socketUrl.searchParams.set('apikey', publishableKey);
      if (session?.access_token) socketUrl.searchParams.set('access_token', session.access_token);
      socket = new (options.WebSocket || globalThis.WebSocket)(socketUrl);
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        const params = {client_id: options.realtimeClientId, ...(channelOptions.filter ? {filter: channelOptions.filter} : {}), ...(channelOptions.presence ? {presence: channelOptions.presence} : {})};
        const r = send('phx_join', params);
        replies.set(r, (reply) => {
          if (reply.status === 'ok') {
            joined = true;
            joinCallbacks.splice(0).forEach((fn) => fn());
          } else {
            const reason = reply.response?.reason || 'join refused';
            for (const fn of errorListeners) fn(Object.assign(new Error(reason), {code: reason}));
          }
        });
        heartbeat = setInterval(() => send('heartbeat', {}, 'phoenix'), 25_000);
      });
      socket.addEventListener('message', (event) => {
        const [, msgRef, msgTopic, name, payload] = JSON.parse(event.data);
        if (name === 'phx_reply' && replies.has(msgRef)) {
          const resolve = replies.get(msgRef);
          replies.delete(msgRef);
          resolve(payload);
          return;
        }
        if (msgTopic !== full) return;
        if (name === 'postgres_changes' || name === 'change') listeners.forEach((listener) => listener(payload));
        if (name === 'broadcast') {
          for (const listener of broadcastListeners.get(payload.event) || []) listener(payload.payload);
          for (const listener of broadcastListeners.get('*') || []) listener(payload.payload, payload.event);
        }
        if (name === 'presence_state' || name === 'presence_diff') {
          presenceListeners.forEach((listener) => listener({event: name, state: payload}));
        }
        if (name === 'graphql') graphqlListeners.get(payload.id)?.(payload.payload);
        if (name === 'system' && payload?.status === 'token_expired') {
          for (const fn of errorListeners) fn(Object.assign(new Error('token_expired'), {code: 'token_expired'}));
        }
      });
      socket.addEventListener('close', () => {
        clearTimers();
        joined = false;
        if (active) {
          const delay = Math.min(1000 * (2 ** reconnectAttempt++), 10_000);
          reconnectTimer = setTimeout(connect, delay);
        }
      });
    };

    const errorListeners = new Set();
    const api = {
      /** Row changes: `{type: 'insert' | 'update' | 'delete', table, record, old}`. */
      onChange(listener) {
        listeners.add(listener);
        return api;
      },
      on(event, listener) {
        if (event === 'change' || event === 'postgres_changes') return api.onChange(listener);
        if (event === 'presence') return api.onPresence(listener);
        if (event === 'error') { errorListeners.add(listener); return api; }
        return api.onBroadcast(event, listener);
      },
      onBroadcast(event, listener) {
        if (!broadcastListeners.has(event)) broadcastListeners.set(event, new Set());
        broadcastListeners.get(event).add(listener);
        return api;
      },
      onPresence(listener) {
        presenceListeners.add(listener);
        return api;
      },
      onError(listener) {
        errorListeners.add(listener);
        return api;
      },
      sendBroadcast(event, payload = {}) {
        if (!send('broadcast', {event, payload})) {
          throw new Error('Realtime channel is not connected');
        }
        return api;
      },
      /** Resolves once the channel has joined. */
      ready: () => new Promise((resolve) => (joined ? resolve() : joinCallbacks.push(resolve))),
      subscribe() {
        if (active) return api;
        active = true;
        connect();
        return api;
      },
      unsubscribe() {
        active = false;
        clearTimers();
        socket?.close();
        listeners.clear();
        broadcastListeners.clear();
        presenceListeners.clear();
        graphqlListeners.clear();
      },
      _push: push,
      _onJoin: (fn) => (joined ? fn() : joinCallbacks.push(fn)),
      _onGraphql: (id, fn) => graphqlListeners.set(id, fn)
    };
    return api;
  }

  const client = {
    auth,
    from,
    table: from,
    /** Defines a model: relations, hooks, scopes, soft deletes and columns for migrations. */
    model(table, options = {}) {
      const model = defineModel(client, table, options);
      models.set(table, model);
      return model;
    },
    _model: (table) => models.get(table),
    _query: direct._query,
    transaction,
    rpc,
    graphql,
    getApi,
    /** Organisations for your app's own users (also at auth.orgs). */
    get orgs() { return auth.orgs; },
    functions,
    channel,
    storage: objectStorage,
    getSchema,
    ...sqlApi((path, init) => call(path, init, false)),
    get apiUrl() { return baseUrl; },
    get lastTraceId() { return lastTraceId; }
  };
  return client;
}

// PKCE (RFC 7636): a random verifier and its S256 challenge.
async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function pkceChallenge(verifier) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
