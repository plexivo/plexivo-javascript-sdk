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

  async function call(path, init = {}, authenticated = false, allowRefresh = true) {
    const headers = new Headers(init.headers || {});
    headers.set('apikey', publishableKey);
    headers.set('content-type', 'application/json');
    if (authenticated) {
      if (!session?.access_token) throw new Error('An authenticated application user is required');
      headers.set('authorization', `Bearer ${session.access_token}`);
    }

    const response = await request(`${baseUrl}${path}`, {...init, headers});
    lastTraceId = response.headers.get('x-trace-id');
    const payload = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (
        authenticated &&
        allowRefresh &&
        response.status === 401 &&
        payload?.error?.code === 'token_expired' &&
        session?.refresh_token
      ) {
        await refreshExpiredSession();
        return call(path, init, true, false);
      }
      const error = new Error(payload?.error?.code || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error?.code;
      error.traceId = payload?.trace_id || lastTraceId;
      throw error;
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
    mfa: {
      enroll: () => call('/auth/mfa/totp/enroll', {method: 'POST', body: '{}'}, true).then((result) => result.factor),
      verify: ({code}) => call('/auth/mfa/totp/verify', {method: 'POST', body: JSON.stringify({code})}, true).then((result) => result.factor),
      unenroll: ({password}) => call('/auth/mfa/totp', {method: 'DELETE', body: JSON.stringify({password})}, true)
    }
  };

  const getSchema = () => call('/meta/schema');

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

  function from(table) {
    const path = `/rest/v1/${encodeURIComponent(table)}`;
    return {
      select: () => call(path, {}, true).then((result) => result.data),
      insert: (value) => call(path, {method: 'POST', body: JSON.stringify(value)}, true).then((result) => result.data),
      get: (id) => call(`${path}/${encodeURIComponent(id)}`, {}, true).then((result) => result.data),
      update: (id, value) => call(`${path}/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify(value)}, true).then((result) => result.data),
      delete: (id) => call(`${path}/${encodeURIComponent(id)}`, {method: 'DELETE'}, true).then((result) => result.data)
    };
  }

  function channel(table = 'items') {
    const listeners = new Set();
    const broadcastListeners = new Map();
    const presenceListeners = new Set();
    let socket;
    let heartbeat;
    let reconnectTimer;
    let reconnectAttempt = 0;
    let active = false;
    let ref = 1;

    const clearTimers = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      heartbeat = null;
      reconnectTimer = null;
    };

    const send = (topic, event, payload) => {
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(['1', String(ref++), topic, event, payload]));
      return true;
    };

    const connect = () => {
      const parsed = new URL(baseUrl);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const project = pathParts.at(-1);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      const socketUrl = new URL(`${protocol}//${parsed.host}/client-data/socket/websocket`);
      socketUrl.searchParams.set('vsn', '2.0.0');
      socketUrl.searchParams.set('project', project);
      socketUrl.searchParams.set('apikey', publishableKey);
      socketUrl.searchParams.set('access_token', session.access_token);
      socket = new (options.WebSocket || globalThis.WebSocket)(socketUrl);
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        send(`realtime:${table}`, 'phx_join', {client_id: options.realtimeClientId});
        heartbeat = setInterval(() => send('phoenix', 'heartbeat', {}), 25_000);
      });
      socket.addEventListener('message', (event) => {
        const [, , topic, name, payload] = JSON.parse(event.data);
        if (topic !== `realtime:${table}`) return;
        if (name === 'change') listeners.forEach((listener) => listener(payload));
        if (name === 'broadcast') {
          for (const listener of broadcastListeners.get(payload.event) || []) listener(payload.payload);
        }
        if (name === 'presence_state' || name === 'presence_diff') {
          presenceListeners.forEach((listener) => listener({event: name, state: payload}));
        }
      });
      socket.addEventListener('close', () => {
        clearTimers();
        if (active) {
          const delay = Math.min(1000 * (2 ** reconnectAttempt++), 10_000);
          reconnectTimer = setTimeout(connect, delay);
        }
      });
    };

    const api = {
      onChange(listener) {
        listeners.add(listener);
        return api;
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
      sendBroadcast(event, payload = {}) {
        if (!send(`realtime:${table}`, 'broadcast', {event, payload})) {
          throw new Error('Realtime channel is not connected');
        }
        return api;
      },
      subscribe() {
        if (!session?.access_token) throw new Error('Sign in before subscribing');
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
      }
    };
    return api;
  }

  return {
    auth,
    from,
    channel,
    storage: objectStorage,
    getSchema,
    get apiUrl() { return baseUrl; },
    get lastTraceId() { return lastTraceId; }
  };
}
