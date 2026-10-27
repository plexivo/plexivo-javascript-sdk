import {apiError, PlexivoError, RecordNotFoundError, isNotFound, isUniqueViolation, isPermissionDenied} from './errors.js';
import {QueryBuilder, Conditions, RpcBuilder} from './query.js';
import {tableContext, defineModel, belongsTo, hasOne, hasMany, manyToMany} from './model.js';
import {sqlApi} from './sql.js';

export {PlexivoError, RecordNotFoundError, isNotFound, isUniqueViolation, isPermissionDenied, belongsTo, hasOne, hasMany, manyToMany, QueryBuilder, Conditions, RpcBuilder};

/** The version of this package. */
export const VERSION = '0.4.0';

const trimSlash = (value) => value.replace(/\/+$/, '');

// A web page or a web worker: anything there can be read by whoever loads it.
const inBrowser = () => typeof window !== 'undefined' ||
  (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope);

export function createClient(apiUrl, publishableKey, options = {}) {
  if (!apiUrl || !publishableKey) throw new Error('apiUrl and publishableKey are required');
  if (String(publishableKey).startsWith('plx_secret_') && inBrowser()) {
    throw new PlexivoError(
      'The secret key is for servers only and must never reach a browser: anyone who opens the page can read it. Use the publishable key here, keep the secret key on your server, and rotate it if it was published.',
      {code: 'secret_key_in_browser'}
    );
  }

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
    if (authenticated === true && !session?.access_token) {
      throw new PlexivoError('Sign in first: this needs a signed-in user', {status: 401, code: 'sign_in_required'});
    }
    const sendToken = authenticated && session?.access_token;
    if (sendToken) {
      headers.set('authorization', `Bearer ${session.access_token}`);
    }

    let response;
    try {
      response = await request(`${baseUrl}${path}`, {...init, headers});
    } catch (error) {
      throw transportError(error);
    }
    lastTraceId = response.headers.get('x-trace-id');
    const payload = response.status === 204 ? null : await readJson(response);
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
    /**
     * A new account. `data` (or Supabase's `options.data`) is kept as the
     * user's `user_metadata`: a JSON object of at most 4 KB.
     */
    signUp: ({options: signUpOptions, ...credentials} = {}) => authenticate('/auth/signup', {
      ...credentials,
      ...(credentials.data === undefined && signUpOptions?.data !== undefined ? {data: signUpOptions.data} : {})
    }),
    /**
     * Changes the signed-in user's `user_metadata`: `data` is merged in, and
     * a key set to `null` is removed. Resolves to the updated user.
     */
    async updateUser({data} = {}) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('updateUser takes {data: {...}}, an object to merge into user_metadata');
      const result = await call('/auth/user', {method: 'PATCH', body: JSON.stringify({data})}, true);
      const user = result?.user ?? result;
      if (session) setSession({...session, user: {...session.user, ...user}}, 'USER_UPDATED');
      return user;
    },
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
      // Already signed out: nothing to revoke on the server.
      if (!session?.access_token) {
        setSession(null, 'SIGNED_OUT');
        return;
      }
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
      throw apiError(response, payload, lastTraceId);
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

  function dataLayer(send, deferred = false) {
    const layer = {
      _send: send,
      _query: (op, opts) => send(() => op, (r) => r, 'raw', opts),
      _model: (table) => models.get(table),
      _throwOnError: options.throwOnError !== false,
      _deferred: deferred,
      /** A query on one table: chain filters, then await it (find) or call a terminal method. */
      from(table) {
        if (typeof table !== 'string' || !table) throw new TypeError('from() takes a table name');
        const model = models.get(table);
        return new QueryBuilder(tableContext(layer, table, model ? {...model} : {}));
      }
    };
    layer.table = layer.from;
    layer.transaction = (callback) => transaction(callback);
    /**
     * A database function exposed with COMMENT ON FUNCTION … IS '@expose'.
     * Awaitable as it is; chain select, filters, order, limit, range,
     * single or maybeSingle for a function that returns rows.
     */
    layer.rpc = (fn, args = {}, rpcOptions = {}) => {
      if (typeof fn !== 'string' || !fn) throw new TypeError('rpc() takes a function name');
      if (deferred) {
        // Inside a transaction: recorded now, like every other operation.
        return send(() => ({op: 'rpc', function: fn, args}), (r) => ({data: r.data, count: r.count ?? null, error: null}), 'raw');
      }
      const ctx = {
        ...tableContext(layer, fn, {}),
        fn,
        args,
        rpcPlain: (name, body, opts) => call(`/rest/v1/rpc/${encodeURIComponent(name)}`, {method: 'POST', body: JSON.stringify(body), ...(opts?.signal ? {signal: opts.signal} : {})}, 'optional')
      };
      let q = new RpcBuilder(ctx);
      if (rpcOptions.count) q = q._with({count: true});
      if (rpcOptions.head) q = q._with({head: true});
      return q;
    };
    return layer;
  }

  const direct = dataLayer((build, finish, _shape, opts) =>
    Promise.resolve().then(build).then((op) => call('/query/v1', {method: 'POST', body: JSON.stringify(op), ...(opts?.signal ? {signal: opts.signal} : {})}, 'optional')).then(finish));

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

    const tx = dataLayer(send, true);
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

  const rpc = direct.rpc;

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
    }), (error) => onResult({errors: [{message: error.message, extensions: {code: error.code}}]}));
    ch.subscribe();
    return {unsubscribe: () => { ch._push('unsubscribe', {id}).catch(() => {}); ch.unsubscribe(); }};
  };

  /** Plexivo Functions: your server-side code beside the data. */
  const functions = {
    async invoke(name, {body, method = 'POST', headers = {}, path = '', query = {}} = {}) {
      if (name === '.' || name === '..') throw new TypeError('Invalid function name');
      const segments = String(path).split('/').filter(Boolean);
      if (segments.some((s) => s === '.' || s === '..')) throw new TypeError('Function path must not contain dot segments');
      const suffix = segments.length ? '/' + segments.map(encodeURIComponent).join('/') : '';
      const url = new URL(`${baseUrl}/functions/v1/${encodeURIComponent(name)}${suffix}`);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      const h = new Headers(headers);
      h.set('apikey', publishableKey);
      if (session?.access_token) h.set('authorization', `Bearer ${session.access_token}`);
      const isJson = body !== undefined && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(typeof Blob !== 'undefined' && body instanceof Blob);
      if (isJson && !h.has('content-type')) h.set('content-type', 'application/json');
      const response = await request(url.toString(), {method, headers: h, body: isJson ? JSON.stringify(body) : body});
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
   *
   * The channel stays joined by itself: when the connection drops, or the
   * server ends the channel (an expired token, a restart), it refreshes the
   * session if it needs to and joins again, with backoff. A join the server
   * refuses (an unknown table, a private room while signed out) is reported
   * to onError / onStatus and ready(), and not retried.
   */
  function channel(topic = 'items', channelOptions = {}) {
    const full = `realtime:${topic}`;
    const listeners = new Set();
    const broadcastListeners = new Map();
    const presenceListeners = new Set();
    const graphqlListeners = new Map();
    const errorListeners = new Set();
    const statusListeners = new Set();
    const joinHooks = new Set();
    const refusalHooks = new Set();
    let readyWaiters = [];
    const replies = new Map();
    const heartbeatMs = options.realtimeHeartbeatMs || 25_000;
    let socket = null;
    let socketToken = null;
    let heartbeat = null;
    let pendingHeartbeat = null;
    let reconnectTimer = null;
    let expiryTimer = null;
    let reconnectAttempt = 0;
    let joinedAt = 0;
    let active = false;
    let joined = false;
    let refused = null;
    let state = 'closed';
    let ref = 1;

    const STATUS = {joined: 'SUBSCRIBED', reconnecting: 'RECONNECTING', refused: 'CHANNEL_ERROR', closed: 'CLOSED'};
    const setState = (next, error) => {
      if (state === next && next !== 'refused') return;
      state = next;
      for (const fn of statusListeners) {
        try { fn(STATUS[next], error); } catch { /* listeners are isolated */ }
      }
    };
    const report = (error) => {
      for (const fn of errorListeners) {
        try { fn(error); } catch { /* listeners are isolated */ }
      }
    };

    const send = (event, payload, topicName = full) => {
      if (!socket || socket.readyState !== 1) return null;
      const r = String(ref++);
      socket.send(JSON.stringify(['1', r, topicName, event, payload]));
      return r;
    };
    const push = (event, payload) => new Promise((resolve, reject) => {
      const r = send(event, payload);
      if (!r) return reject(new PlexivoError('Realtime channel is not connected', {code: 'not_connected'}));
      replies.set(r, resolve);
      setTimeout(() => { if (replies.delete(r)) reject(new PlexivoError('Realtime reply timed out', {code: 'timeout'})); }, 10_000);
    });

    // Closes this connection now; its late events are ignored.
    const drop = () => {
      const ws = socket;
      socket = null;
      joined = false;
      if (heartbeat) clearInterval(heartbeat);
      if (expiryTimer) clearTimeout(expiryTimer);
      heartbeat = null;
      expiryTimer = null;
      pendingHeartbeat = null;
      replies.clear();
      if (ws) {
        try { ws.close(); } catch { /* already closed */ }
      }
    };

    const reconnect = (immediate = false) => {
      if (!active || reconnectTimer) return;
      // A connection that stayed up a while starts the backoff again.
      if (joinedAt && Date.now() - joinedAt > 30_000) reconnectAttempt = 0;
      joinedAt = 0;
      const attempt = reconnectAttempt++;
      const delay = immediate && attempt === 0 ? 0 : Math.min(500 * (2 ** attempt), 15_000) * (0.8 + Math.random() * 0.4);
      setState('reconnecting');
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };

    const refuse = (error) => {
      refused = error;
      active = false;
      drop();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      setState('refused', error);
      for (const w of readyWaiters) w.reject(error);
      readyWaiters = [];
      for (const fn of refusalHooks) fn(error);
      report(error);
    };

    // Refreshes the session shortly before the token the channel joined with
    // expires, so the channel moves to the new token without missing a change.
    const watchExpiry = (token) => {
      const claims = tokenClaims(token);
      if (!claims?.exp) return;
      const life = claims.iat ? (claims.exp - claims.iat) * 1000 : 3_600_000;
      const margin = Math.min(60_000, Math.max(1_000, life * 0.2));
      const wait = Math.max(0, claims.exp * 1000 - Date.now() - margin);
      expiryTimer = setTimeout(() => {
        expiryTimer = null;
        if (!active || socketToken !== token) return;
        if (session?.access_token === token && session?.refresh_token) refreshExpiredSession().catch(() => {});
        else onAuth();
      }, Math.min(wait, 2_147_000_000));
    };

    // A new session (refreshed, signed in or out): join again with it.
    const onAuth = () => {
      if (!active || reconnectTimer) return;
      const token = session?.access_token || null;
      if (token === socketToken || (!socket && !joined)) return;
      drop();
      reconnectAttempt = 0;
      reconnect(true);
    };

    const connect = async () => {
      if (!active) return;
      // The socket checks the token when it connects: refresh one that has expired or is about to.
      if (session?.access_token && session?.refresh_token && expiresWithin(session.access_token, 5)) {
        try {
          await refreshExpiredSession();
        } catch (error) {
          if (!active) return;
          if (error?.status >= 400 && error?.status < 500) return refuse(error);
          return reconnect();
        }
      }
      if (!active || socket) return;
      const parsed = new URL(baseUrl);
      const project = parsed.pathname.split('/').filter(Boolean).at(-1);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      const socketUrl = new URL(`${protocol}//${parsed.host}/client-data/socket/websocket`);
      socketUrl.searchParams.set('vsn', '2.0.0');
      socketUrl.searchParams.set('project', project);
      socketUrl.searchParams.set('apikey', publishableKey);
      const token = session?.access_token || null;
      if (token) socketUrl.searchParams.set('access_token', token);
      const ws = new (options.WebSocket || globalThis.WebSocket)(socketUrl.toString());
      socket = ws;
      socketToken = token;

      ws.addEventListener('open', () => {
        if (ws !== socket) return;
        const params = {client_id: options.realtimeClientId, ...(channelOptions.filter ? {filter: channelOptions.filter} : {}), ...(channelOptions.presence ? {presence: channelOptions.presence} : {})};
        const r = send('phx_join', params);
        replies.set(r, (reply) => {
          if (ws !== socket) return;
          if (reply.status === 'ok') {
            joined = true;
            joinedAt = Date.now();
            refused = null;
            setState('joined');
            for (const w of readyWaiters) w.resolve();
            readyWaiters = [];
            for (const fn of joinHooks) {
              try { fn(); } catch { /* isolated */ }
            }
            if (token) watchExpiry(token);
          } else {
            // Refused (table_not_exposed, sign_in_required, …): reported, not retried.
            const reason = reply.response?.reason || 'join_refused';
            refuse(new PlexivoError(`Realtime refused to join ${topic}: ${reason}`, {code: reason, details: reply.response?.message}));
          }
        });
        heartbeat = setInterval(() => {
          if (ws !== socket) return;
          if (pendingHeartbeat) {
            // No answer to the last heartbeat: the connection is gone.
            drop();
            reconnect();
            return;
          }
          pendingHeartbeat = send('heartbeat', {}, 'phoenix');
        }, heartbeatMs);
      });

      ws.addEventListener('message', (event) => {
        if (ws !== socket) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const [, msgRef, msgTopic, name, payload] = message;
        if (name === 'phx_reply' && msgRef != null && msgRef === pendingHeartbeat) {
          pendingHeartbeat = null;
          return;
        }
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
          report(new PlexivoError('The session expired; joining again with a fresh one', {code: 'token_expired', status: 401}));
        }
        if (name === 'phx_close' || name === 'phx_error') {
          // The server ended the channel: join again on a fresh connection.
          drop();
          reconnect(true);
        }
      });

      ws.addEventListener('close', () => {
        if (ws !== socket) return;
        drop();
        reconnect();
      });
    };

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
      /** `SUBSCRIBED` on every join, `RECONNECTING`, `CHANNEL_ERROR` (refused) and `CLOSED`. */
      onStatus(listener) {
        statusListeners.add(listener);
        return api;
      },
      /** `'closed'`, `'connecting'`, `'joined'`, `'reconnecting'` or `'refused'`. */
      get state() { return state; },
      get joined() { return joined; },
      sendBroadcast(event, payload = {}) {
        if (!send('broadcast', {event, payload})) {
          throw new PlexivoError('Realtime channel is not connected', {code: 'not_connected'});
        }
        return api;
      },
      /** Resolves once the channel has joined; rejects with a PlexivoError when the join is refused. */
      ready: () => new Promise((resolve, reject) => {
        if (joined) return resolve();
        if (refused) return reject(refused);
        readyWaiters.push({resolve, reject});
      }),
      subscribe(callback) {
        if (typeof callback === 'function') statusListeners.add(callback);
        if (active) return api;
        active = true;
        refused = null;
        authListeners.add(onAuth);
        state = 'connecting';
        connect();
        return api;
      },
      unsubscribe() {
        const wasActive = active;
        active = false;
        authListeners.delete(onAuth);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        drop();
        if (wasActive) setState('closed');
        listeners.clear();
        broadcastListeners.clear();
        presenceListeners.clear();
        graphqlListeners.clear();
        statusListeners.clear();
        joinHooks.clear();
        refusalHooks.clear();
      },
      _push: push,
      // Runs on every join (and now, when joined); onRefused hears a refusal.
      _onJoin: (fn, onRefused) => {
        joinHooks.add(fn);
        if (onRefused) refusalHooks.add(onRefused);
        if (joined) fn();
      },
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

// A JSON body, or null when there is none or it is not JSON (a proxy's HTML
// error page, say): a failure must still surface as a PlexivoError with its
// status, not as a SyntaxError from the parser.
// A request that never got an answer: aborted by its signal, or a network failure.
function transportError(error) {
  if (error instanceof PlexivoError) return error;
  if (error?.name === 'AbortError') return new PlexivoError('The request was aborted', {code: 'aborted', cause: error});
  return new PlexivoError(`The Data API could not be reached: ${error?.message || error}`, {code: 'network_error', cause: error});
}

// The claims of an access token (a JWT), without checking it: only to know when it expires.
function tokenClaims(token) {
  try {
    const part = String(token).split('.')[1];
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

function expiresWithin(token, seconds) {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === 'number' && exp * 1000 - Date.now() < seconds * 1000;
}

async function readJson(response) {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!response.ok) return null;
    throw new PlexivoError('The Data API returned a response that is not JSON', {status: response.status, code: 'invalid_response'});
  }
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
