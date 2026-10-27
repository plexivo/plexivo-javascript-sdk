/**
 * The client for Plexivo Postgres: your database's Data API, authentication,
 * realtime, GraphQL, Plexivo Functions and file storage, from the browser,
 * React Native, Vue or Node.
 *
 * Work with data two ways on one query builder:
 *
 * - **Supabase-style**: `from('notes').select('id, body').eq('pinned', true)`,
 *   which returns `{data, count}`.
 * - **GORM-style**: models, relations, `preload`, `whereHas`, `first`,
 *   `create`, `save`, scopes, hooks, soft deletes, transactions and
 *   association mode, plus migrations and raw SQL on your server.
 *
 * Row-level security decides what every request can read and write. Start
 * with {@link createClient}.
 *
 * @example
 * ```ts
 * import { createClient } from '@plexivo/client';
 *
 * const db = createClient(PLEXIVO_DATA_URL, PLEXIVO_PUBLISHABLE_KEY);
 * await db.auth.signInWithPassword({ email, password });
 *
 * const posts = await db.from('posts')
 *   .where('likes', '>', 10)
 *   .preload('author')
 *   .order('created_at', 'desc')
 *   .limit(20);
 * ```
 *
 * @packageDocumentation
 */

/** Any value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ── auth ───────────────────────────────────────────────────────────────────

/** An email and password, for {@link AuthClient.signUp} and {@link AuthClient.signInWithPassword}. */
export type Credentials = {
  /** The user's email address. */
  email: string;
  /** The user's password. */
  password: string;
  /** The current code from the user's authenticator app. Needed only when the account has two-factor authentication on. */
  mfa_code?: string;
  /** For {@link AuthClient.signUp}: your own details about the user (a JSON object of at most 4 KB), kept as `user_metadata`. */
  data?: { [key: string]: Json };
  /** Supabase's form: `options.data` is the same as `data`. */
  options?: {
    /** The same as `data`. */
    data?: { [key: string]: Json };
  };
};

/** One of your app's users. Its `id` is `auth.uid()` in row-level security policies. */
export type AppUser = {
  /** The user's id: `auth.uid()` in policies. */
  id: string;
  /** The user's email address, or `null` for a guest. */
  email: string | null;
  /** `true` for a guest from {@link AuthClient.signInAnonymously}. */
  is_anonymous?: boolean;
  /** When the account was created (ISO 8601). */
  created_at?: string;
  /**
   * Your own details about the user, from `signUp({ data })` and
   * {@link AuthClient.updateUser}: a display name, a plan, preferences.
   * The user can change it, so never base an access decision on it.
   */
  user_metadata?: { [key: string]: Json };
  /** Two-factor authentication status. */
  mfa?: {
    /** `'totp'` once an authenticator app is enrolled, otherwise `null`. */
    factor_type: 'totp' | null;
    /** `'pending'` after {@link AuthClient.mfa | mfa.enroll}, `'enabled'` after `mfa.verify`. */
    status: 'unenrolled' | 'pending' | 'enabled';
    /** When the factor was verified (ISO 8601), or `null`. */
    verified_at: string | null;
  };
};

/** A signed-in session. The client keeps it, sends it and refreshes it for you. */
export type Session = {
  /** The short-lived bearer token sent with every request. */
  access_token: string;
  /** The token that gets a new access token when this one expires. */
  refresh_token: string;
  /** Always `'bearer'`. */
  token_type: 'bearer';
  /** Seconds until the access token expires. */
  expires_in: number;
  /** `'aal2'` after a two-factor check, otherwise `'aal1'`. */
  assurance_level: 'aal1' | 'aal2';
  /** The signed-in user. */
  user: AppUser;
};

/** One device where the user is signed in, from {@link AuthClient.listSessions}. */
export type DeviceSession = {
  /** The session id, for {@link AuthClient.revokeSession}. */
  id: string;
  /** `true` for the session this client is using. */
  current: boolean;
  /** The browser or app that signed in, when known. */
  user_agent?: string | null;
  /** The IP address it signed in from, when known. */
  ip?: string | null;
  /** When the session started (ISO 8601). */
  created_at: string;
  /** When the session was last used (ISO 8601), when known. */
  last_used_at?: string | null;
};

/** An organisation (a team) of your app's users. */
export type Organisation = {
  /** The organisation id. */
  id: string;
  /** Its display name. */
  name: string;
  /** Its short, URL-friendly name, when set. */
  slug?: string;
  /** The signed-in user's role in it. */
  role: 'owner' | 'admin' | 'member';
  /** Your own data about the organisation. */
  metadata?: Json;
};

/** A member of an {@link Organisation}. */
export type Member = {
  /** The member's user id. */
  user_id: string;
  /** The member's email address, or `null`. */
  email: string | null;
  /** The member's role. */
  role: 'owner' | 'admin' | 'member';
};

/** An invitation to join an {@link Organisation}. */
export type Invitation = {
  /** The invitation id, for {@link OrgsClient.revokeInvitation}. */
  id: string;
  /** Who is invited. */
  email: string;
  /** The role they get when they accept. */
  role: string;
  /** The secret the invitee passes to {@link OrgsClient.acceptInvitation}. Returned when you create the invitation. */
  token?: string;
  /** When the invitation stops working (ISO 8601). */
  expires_at?: string;
};

/**
 * A sign-in provider for {@link AuthClient.signInWithOAuth}: `'google'`,
 * `'github'`, `'microsoft'`, or the id of another provider set up for the
 * project (see {@link AuthClient.getProviders}).
 */
export type OAuthProvider = 'google' | 'github' | 'microsoft' | (string & {});

/**
 * Organisations for your app's own users: teams with roles, members and
 * invitations. Also at `db.orgs`.
 *
 * Every method needs a signed-in user and throws an `Error` without one. A
 * refused request rejects with a {@link PlexivoError}.
 *
 * @example
 * ```ts
 * const team = await db.orgs.create({ name: 'Acme' });
 * const invite = await db.orgs.invite(team.id, { email: 'ben@acme.in', role: 'member' });
 * // The invitee, signed in:
 * await db.orgs.acceptInvitation(invite.token!);
 * ```
 */
export interface OrgsClient {
  /** The organisations the signed-in user belongs to, with their role in each. */
  list(): Promise<Organisation[]>;
  /**
   * Creates an organisation for the signed-in user.
   * @param input - Its name, and optionally a slug and your own metadata.
   * @returns The new organisation.
   */
  create(input: { name: string; slug?: string; metadata?: Json }): Promise<Organisation>;
  /**
   * Deletes an organisation.
   * @param orgId - The organisation to delete.
   * @returns `null` once it is gone.
   */
  delete(orgId: string): Promise<null>;
  /**
   * The members of an organisation.
   * @param orgId - The organisation.
   */
  members(orgId: string): Promise<Member[]>;
  /**
   * Changes a member's role.
   * @param orgId - The organisation.
   * @param userId - The member's user id.
   * @param role - The new role, such as `'admin'` or `'member'`.
   * @returns The member with the new role.
   */
  setRole(orgId: string, userId: string, role: string): Promise<Member>;
  /**
   * Removes a member from an organisation.
   * @param orgId - The organisation.
   * @param userId - The member's user id.
   * @returns `null` once removed.
   */
  removeMember(orgId: string, userId: string): Promise<null>;
  /**
   * The open invitations of an organisation.
   * @param orgId - The organisation.
   */
  invitations(orgId: string): Promise<Invitation[]>;
  /**
   * Invites someone by email.
   * @param orgId - The organisation.
   * @param input - Their email, and the role they get (`'member'` when left out).
   * @returns The invitation, with the `token` the invitee needs to accept it.
   */
  invite(orgId: string, input: { email: string; role?: string }): Promise<Invitation>;
  /**
   * Withdraws an invitation before it is accepted.
   * @param orgId - The organisation.
   * @param invitationId - The invitation's id.
   * @returns `null` once withdrawn.
   */
  revokeInvitation(orgId: string, invitationId: string): Promise<null>;
  /**
   * Accepts an invitation as the signed-in user. Same as {@link OrgsClient.acceptInvitation}.
   * @param token - The invitation's token.
   * @returns The organisation joined.
   */
  accept(token: string): Promise<Organisation>;
  /**
   * Accepts an invitation as the signed-in user.
   * @param token - The invitation's token.
   * @returns The organisation joined.
   */
  acceptInvitation(token: string): Promise<Organisation>;
}

/**
 * Your app's own users, ready for row-level security (`auth.uid()` in
 * policies): passwords, email codes, guests, social sign-in, two-factor
 * authentication, signed-in devices and organisations.
 *
 * Sessions persist in `localStorage` in a browser; choose another store with
 * the `storage` option of {@link createClient}. An expired access token is
 * refreshed once and the request retried.
 *
 * A refused request rejects with a {@link PlexivoError}. A method that needs
 * a signed-in user throws an `Error` when there is none.
 */
export interface AuthClient {
  /**
   * Creates an account and signs it in. Listeners get `'SIGNED_UP'`.
   *
   * @param credentials - The new user's email and password, and `data`: your own details about the user (a JSON object of at most 4 KB), kept as `user.user_metadata`.
   * @returns The new session, also kept by the client.
   * @throws {@link PlexivoError} when the server refuses, for example because the email is taken.
   *
   * @example
   * ```ts
   * const session = await db.auth.signUp({ email: 'asha@example.com', password, data: { display_name: 'Asha' } });
   * console.log(session.user.id, session.user.user_metadata);
   * ```
   */
  signUp(credentials: Credentials): Promise<Session>;
  /**
   * Changes the signed-in user's `user_metadata`: `data` is merged into it,
   * and a key set to `null` is removed. The kept session's user is updated
   * and listeners get `'USER_UPDATED'`.
   *
   * @param input - `data`: the keys to set (or remove, with `null`).
   * @returns The updated user.
   * @throws TypeError when `data` is not an object.
   * @throws {@link PlexivoError} coded `sign_in_required` when signed out, or when the server refuses (more than 4 KB, say).
   *
   * @example
   * ```ts
   * const user = await db.auth.updateUser({ data: { theme: 'dark', beta: null } });
   * ```
   */
  updateUser(input: { data: { [key: string]: Json } }): Promise<AppUser>;
  /**
   * Signs in with an email and password. Listeners get `'SIGNED_IN'`.
   *
   * @param credentials - The email and password, plus `mfa_code` when the account has two-factor authentication on.
   * @returns The session, also kept by the client.
   * @throws {@link PlexivoError} when the email or password is wrong, or a two-factor code is needed.
   *
   * @example
   * ```ts
   * try {
   *   await db.auth.signInWithPassword({ email, password });
   * } catch (error) {
   *   if (error instanceof PlexivoError) showMessage(error.message);
   * }
   * ```
   */
  signInWithPassword(credentials: Credentials): Promise<Session>;
  /**
   * A guest session, when the project allows guests. Turn the guest into an
   * account later with {@link AuthClient.linkEmail}. Listeners get `'SIGNED_IN'`.
   */
  signInAnonymously(): Promise<Session>;
  /**
   * The guest becomes an account with this email and password, keeping its id
   * and rows. Needs a signed-in guest. Listeners get `'USER_UPDATED'`.
   *
   * @param input - The email and password for the account.
   * @returns The upgraded session.
   */
  linkEmail(input: { email: string; password: string }): Promise<Session>;
  /**
   * Starts social sign-in (OAuth with PKCE). In a browser the page goes to the
   * provider, unless `skipBrowserRedirect` is set, and the code verifier is
   * kept for you. Finish with {@link AuthClient.exchangeCodeForSession}.
   *
   * @param input - The `provider`; `redirectTo`, where the provider sends the user back (the current page when left out); and `skipBrowserRedirect` to get the URL without navigating.
   * @returns The provider URL and the PKCE code verifier.
   */
  signInWithOAuth(input: { provider: OAuthProvider; redirectTo?: string; skipBrowserRedirect?: boolean }): Promise<{
    /** The URL to send the browser to. */
    url: string;
    /** The PKCE verifier. Keep it for {@link AuthClient.exchangeCodeForSession} outside a browser. */
    codeVerifier: string;
  }>;
  /**
   * Finishes social sign-in with the `code` from the redirect. Listeners get `'SIGNED_IN'`.
   *
   * @param code - The `code` query parameter the provider sent back.
   * @param codeVerifier - The verifier from {@link AuthClient.signInWithOAuth}. Kept for you in a browser.
   * @returns The session, also kept by the client.
   * @throws Error when there is no code verifier.
   */
  exchangeCodeForSession(code: string, codeVerifier?: string): Promise<Session>;
  /** The sign-in methods this project has turned on. */
  getProviders(): Promise<{
    /** The social and single sign-on providers. */
    providers: Array<{
      /** The id to pass to {@link AuthClient.signInWithOAuth}. */
      id: string;
      /** `'oauth'` or `'oidc'`. */
      type: 'oauth' | 'oidc';
      /** A name to show on the button. */
      name: string;
    }>;
    /** Email and password sign-in. */
    password: {
      /** Whether it is on. */
      enabled: boolean;
    };
    /** Sign-in with a one-time code sent by email. */
    passwordless_email: {
      /** Whether it is on. */
      enabled: boolean;
      /** How the code is delivered: `'otp'`. */
      delivery: 'otp';
    };
  }>;
  /**
   * Emails a password reset code. Finish with {@link AuthClient.verifyPasswordRecovery}.
   * @param email - The account's email address.
   */
  resetPasswordForEmail(email: string): Promise<{
    /** Always `true`; the answer is the same whether or not the account exists. */
    accepted: true;
  }>;
  /**
   * Sets a new password with the code from {@link AuthClient.resetPasswordForEmail}.
   * @param input - The email, the emailed `code` and the `newPassword`.
   */
  verifyPasswordRecovery(input: { email: string; code: string; newPassword: string }): Promise<void>;
  /**
   * Emails a one-time sign-in code. Finish with {@link AuthClient.verifyOtp}.
   * @param input - The email address to send the code to.
   */
  signInWithOtp(input: { email: string }): Promise<{
    /** Always `true` when the request was taken. */
    accepted: true;
  }>;
  /**
   * Signs in with the emailed one-time code. Listeners get `'SIGNED_IN'`.
   * @param input - The email, the code as `token`, and `mfaCode` when the account has two-factor authentication on.
   * @returns The session, also kept by the client.
   */
  verifyOtp(input: { email: string; token: string; mfaCode?: string }): Promise<Session>;
  /**
   * Gets a new access token now. You rarely need this: the client refreshes
   * an expired token on its own. Listeners get `'TOKEN_REFRESHED'`.
   *
   * @param refreshToken - The refresh token to use. The current session's when left out.
   * @throws Error when there is no refresh token.
   */
  refreshSession(refreshToken?: string): Promise<Session>;
  /** The current session, or `null`. Makes no request. */
  getSession(): Session | null;
  /**
   * The signed-in user, fresh from the server.
   * @throws PlexivoError `sign_in_required` (401) when no user is signed in.
   */
  getUser(): Promise<AppUser>;
  /**
   * Changes the signed-in user's password. The local session is cleared
   * afterwards, so sign in again with the new password. Listeners get
   * `'PASSWORD_RECOVERY'` with a `null` session.
   *
   * @param input - The current password and the new one.
   */
  updatePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
  /**
   * Deletes the signed-in user's account. Listeners get `'USER_DELETED'`.
   * @param input - The user's password, to confirm.
   */
  deleteUser(input: { password: string }): Promise<void>;
  /**
   * Signs out. `'local'` (the default) ends this device's session; `'global'`
   * ends every session of the user. The local session is cleared even if the
   * request fails. Listeners get `'SIGNED_OUT'`.
   *
   * @param options - `scope`: `'local'` or `'global'`.
   * Signing out while already signed out resolves at once and still reports `SIGNED_OUT`.
   *
   * @example
   * ```ts
   * await db.auth.signOut();                     // this device
   * await db.auth.signOut({ scope: 'global' });  // every device
   * ```
   */
  signOut(options?: { scope?: 'local' | 'global' }): Promise<void>;
  /** The devices where the signed-in user is signed in; `current` marks this one. */
  listSessions(): Promise<DeviceSession[]>;
  /** Same as {@link AuthClient.listSessions}. */
  getSessions(): Promise<DeviceSession[]>;
  /**
   * Signs one device out.
   * @param sessionId - The {@link DeviceSession} id.
   * @returns `null` once revoked.
   */
  revokeSession(sessionId: string): Promise<null>;
  /**
   * Calls `listener` whenever the session changes. It is not called for the
   * session you already have; read that with {@link AuthClient.getSession}.
   * An error in a listener is caught and does not affect the client.
   *
   * Events: `'SIGNED_UP'`, `'SIGNED_IN'`, `'TOKEN_REFRESHED'`,
   * `'USER_UPDATED'`, `'SIGNED_OUT'`, `'USER_DELETED'` and
   * `'PASSWORD_RECOVERY'` (after {@link AuthClient.updatePassword}).
   *
   * @param listener - Gets the event name and the new session, or `null` when signed out.
   * @returns A subscription to stop listening.
   *
   * @example
   * ```ts
   * const { data: { subscription } } = db.auth.onAuthStateChange((event, session) => {
   *   setUser(session?.user ?? null);
   * });
   * // Later:
   * subscription.unsubscribe();
   * ```
   */
  onAuthStateChange(listener: (event: string, session: Session | null) => void): {
    /** Holds the subscription. */
    data: {
      /** The listener's subscription. */
      subscription: {
        /** Stops calling the listener. */
        unsubscribe(): void;
      };
    };
  };
  /** Organisations for your app's users. Same as `db.orgs`. */
  orgs: OrgsClient;
  /** Two-factor authentication with an authenticator app (TOTP). Needs a signed-in user. */
  mfa: {
    /**
     * Starts enrolment. Show `uri` as a QR code, then confirm with `mfa.verify`.
     * @returns The pending factor.
     */
    enroll(): Promise<{
      /** Always `'totp'`. */
      factor_type: 'totp';
      /** The shared secret, for typing into an authenticator app by hand. */
      secret: string;
      /** An `otpauth://` URI to show as a QR code. */
      uri: string;
      /** `'pending'` until verified. */
      status: 'pending';
    }>;
    /**
     * Turns two-factor authentication on with a code from the authenticator app.
     * @param input - The six-digit `code`.
     * @returns The enabled factor.
     */
    verify(input: { code: string }): Promise<{
      /** Always `'totp'`. */
      factor_type: 'totp';
      /** `'enabled'`. */
      status: 'enabled';
    }>;
    /**
     * Turns two-factor authentication off.
     * @param input - The user's password, to confirm.
     */
    unenroll(input: { password: string }): Promise<void>;
  };
  /**
   * Bring users over from another system with their password hashes, so they
   * keep their passwords.
   *
   * **Server-only, with the secret key.** Never ship the secret key in a
   * browser or mobile app.
   */
  admin: {
    /**
     * Brings over the users of a database moved from Supabase, with their
     * password hashes. Server-only, with the secret key.
     * @returns Counts, by outcome.
     */
    importFromSupabase(): Promise<Record<string, number>>;
    /**
     * Imports users with their existing password hashes. Server-only, with the secret key.
     * @param users - Each user's `email`, and optionally `id`, `password_hash`, `email_confirmed_at` and `metadata`.
     * @returns Counts, by outcome.
     *
     * @example
     * ```ts
     * const server = createClient(PLEXIVO_DATA_URL, process.env.PLEXIVO_SECRET_KEY!, { persistSession: false });
     * await server.auth.admin.importUsers([{ email: 'asha@example.com', password_hash }]);
     * ```
     */
    importUsers(users: Array<{ id?: string; email: string; password_hash?: string; email_confirmed_at?: string | null; metadata?: Json }>): Promise<Record<string, number>>;
  };
}

// ── results and errors ─────────────────────────────────────────────────────

/**
 * Rows that read both ways: an array (`rows[0]`, `rows.length`, `for…of`)
 * that also carries `data` (itself), `count` and `error: null`, so
 * `const { data, count } = await query` works as it does with Supabase.
 */
export type Result<T> = T[] & {
  /** The rows (the same array). */
  readonly data: T[];
  /** The total number of matching rows when you asked for it with `select({ count: 'exact' })`; otherwise the number returned. */
  readonly count: number | null;
  /** Always `null`. Failures reject with a {@link PlexivoError} instead. */
  readonly error: null;
};

/**
 * A failure, as an awaited query or `rpc()` resolves with
 * `createClient(url, key, { throwOnError: false })` instead of rejecting.
 */
export type Failure = {
  /** Always `null`. */
  data: null;
  /** Always `null`. */
  count: null;
  /** What went wrong. */
  error: PlexivoError;
};

/** `T`, or a {@link Failure} when the client was created with `throwOnError: false`. */
export type Outcome<T, Throws extends boolean> = Throws extends false ? T | Failure : T;

/** One row from {@link QueryBuilder.single} or {@link QueryBuilder.maybeSingle}. */
export type SingleResult<T> = {
  /** The row, or `null` from `maybeSingle()` when nothing matched. */
  data: T | null;
  /** How many rows matched. */
  count: number | null;
  /** Always `null`. Failures reject with a {@link PlexivoError} instead. */
  error: null;
};

/**
 * Every failure the server reports, and every request the client refuses to
 * send. It carries what the Data API said and the trace id to quote to
 * support.
 *
 * Codes you may see:
 *
 * - From the client: `missing_where` (an update or delete without a filter),
 *   `multiple_rows` (`sole()`, `single()` or `maybeSingle()` found more than
 *   one), `record_not_found` (see {@link RecordNotFoundError}), `not_found`,
 *   `transaction_already_sent`, `invalid_response`, `aborted` (the request's
 *   `abortSignal` fired), `network_error` (no answer; the original error is
 *   `cause`) and `secret_key_in_browser` (from {@link createClient}).
 * - From the server: `unique_violation`, `foreign_key_violation`,
 *   `check_violation`, `permission_denied`, `table_not_exposed`,
 *   `token_expired` and more.
 *
 * @example
 * ```ts
 * import { PlexivoError, isUniqueViolation } from '@plexivo/client';
 *
 * try {
 *   await db.from('users').create({ email });
 * } catch (error) {
 *   if (isUniqueViolation(error)) return 'That email is taken.';
 *   if (error instanceof PlexivoError) console.error(error.code, error.traceId);
 *   throw error;
 * }
 * ```
 */
export class PlexivoError extends Error {
  /**
   * @param message - What went wrong.
   * @param options - The details: HTTP `status`, `code`, `hint`, `sqlstate`, `traceId`, `details` and, in a transaction, `operation`.
   */
  constructor(message: string, options?: {
    status?: number;
    code?: string;
    hint?: string;
    sqlstate?: string;
    traceId?: string | null;
    details?: unknown;
    operation?: number;
    cause?: unknown;
  });
  /** The HTTP status, or `0` when the request was never sent. */
  status: number;
  /** A stable, machine-readable code, such as `unique_violation` or `missing_where`. */
  code?: string;
  /** A suggestion for fixing it, when the server has one. */
  hint?: string;
  /** The PostgreSQL error code (SQLSTATE), such as `23505`, for a database error. */
  sqlstate?: string;
  /** The trace id of the request. Quote it to support. */
  traceId: string | null;
  /** More detail from the server, when it sends some. */
  details?: unknown;
  /** In a transaction, which operation failed (0-based). */
  operation?: number;
}

/**
 * No row matched: thrown by `first()`, `last()`, `take()`, `sole()`,
 * `single()`, and `update(id, …)` or `delete(id)` when the row does not
 * exist. Like GORM's `ErrRecordNotFound`. Its `status` is 404 and its `code`
 * is `record_not_found`.
 *
 * @example
 * ```ts
 * try {
 *   return await db.from('posts').first(id);
 * } catch (error) {
 *   if (error instanceof RecordNotFoundError) return null;
 *   throw error;
 * }
 * ```
 */
export class RecordNotFoundError extends PlexivoError {
  /** @param table - The table that had no matching row. */
  constructor(table: string);
  /** The table that had no matching row. */
  table: string;
}

/**
 * True for a {@link RecordNotFoundError}, and for any error with code
 * `record_not_found` or `not_found`.
 * @param error - Anything caught.
 */
export function isNotFound(error: unknown): boolean;
/**
 * True when a unique constraint refused the write (code `unique_violation`, SQLSTATE 23505).
 * @param error - Anything caught.
 */
export function isUniqueViolation(error: unknown): boolean;
/**
 * True when row-level security or a grant refused the request (code
 * `permission_denied`, or HTTP 403).
 * @param error - Anything caught.
 */
export function isPermissionDenied(error: unknown): boolean;

// ── queries ────────────────────────────────────────────────────────────────

/**
 * A comparison for {@link Conditions.where}. SQL symbols and their names both
 * work: `'='`/`'eq'`, `'!='`/`'<>'`/`'neq'`, `'>'`/`'gt'`, `'>='`/`'gte'`,
 * `'<'`/`'lt'`, `'<='`/`'lte'`; `'like'`, `'ilike'` and their `'not …'`
 * forms; `'~'`/`'match'` and `'~*'`/`'imatch'` for regular expressions;
 * `'in'`, `'not in'`, `'is'`, `'is not'`; `'contains'`/`'@>'`,
 * `'contained by'`/`'<@'` and `'overlaps'`/`'&&'` for arrays and JSON; and
 * `'fts'`, `'plfts'`, `'phfts'`, `'wfts'`/`'search'` for full-text search,
 * optionally with a language: `'wfts(english)'`.
 */
export type Operator =
  | '=' | '==' | '!=' | '<>' | '>' | '>=' | '<' | '<='
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'not like' | 'not ilike' | 'match' | 'imatch' | '~' | '~*'
  | 'in' | 'not in' | 'is' | 'is not'
  | 'contains' | '@>' | 'contained by' | '<@' | 'overlaps' | '&&'
  | 'fts' | 'plfts' | 'phfts' | 'wfts' | 'search' | `${'fts' | 'plfts' | 'phfts' | 'wfts'}(${string})`;

/**
 * A filter as the Data API receives it: a tree of `and`, `or` and `not`
 * around column conditions and related-row checks. You rarely write one by
 * hand; see {@link QueryBuilder.toQuery}.
 */
export type FilterNode =
  | {
    /** Every node must match. */
    and: FilterNode[];
  }
  | {
    /** At least one node must match. */
    or: FilterNode[];
  }
  | {
    /** The node must not match. */
    not: FilterNode;
  }
  | {
    /** The column to compare. */
    column: string;
    /** The operator, by its Data API name (`eq`, `gt`, `in`, `is`, `cs`, …). */
    op: string;
    /** The value to compare with. */
    value: Json;
  }
  | {
    /** The json or jsonb column. */
    column: string;
    /** The keys to follow inside it. */
    path: string[];
    /** The operator, by its Data API name. */
    op: string;
    /** The value to compare with. */
    value: Json;
  }
  | {
    /** The column whose value must be among the subquery's. */
    column: string;
    /** Always `'in'`; wrap in `not` for NOT IN. */
    op: 'in';
    /** The subquery, run as the caller under its table's row-level security. */
    query: {
      /** The table. */
      from: string;
      /** The one column it returns. */
      select: string;
      /** Its filter. */
      where?: FilterNode;
    };
  }
  | {
    /** A related table that must have a matching row. */
    has: string;
    /** The foreign key constraint to join on, when there is more than one. */
    hint?: string;
    /** The filter on the related rows. */
    where?: FilterNode;
  };

/** The column names of a row type, as strings. */
type Cols<Row> = Extract<keyof Row, string>;
/** A filter group: gets an empty {@link Conditions}, returns it with filters added. */
type Grouper = (q: Conditions<any>) => Conditions<any> | void;
/** Shapes related rows: gets an {@link EmbedBuilder}, returns it refined. */
type Related = (q: EmbedBuilder) => EmbedBuilder | void;
/** A query used as the value of `whereIn` / `whereNotIn`: `db.from('profiles').select('id').where(…)`. */
export type Subquery = QueryBuilder<any, any, any, any>;
/** Names the embed (related rows) that `order`, `limit`, `offset` or `range` applies to, as Supabase does. */
export type EmbedTarget = {
  /** The embed's name (its alias, or its table). */
  referencedTable?: string;
  /** The older name for `referencedTable`. */
  foreignTable?: string;
};

/**
 * Filters, alone (for groups) or as part of a query. Every method returns a
 * new builder; the one you called it on is unchanged, so a base query can be
 * shared and refined.
 *
 * Calls chain with AND; `orWhere` starts an OR. AND binds tighter than OR, as
 * in SQL. Group with a function: `where((q) => q.where('a', 1).orWhere('b', 2))`.
 *
 * @example
 * ```ts
 * await db.from('posts')
 *   .where('published', true)
 *   .where((q) => q.where('likes', '>', 100).orWhere({ featured: true }))
 *   .whereIn('category', ['news', 'tips'])
 *   .whereNotNull('cover_url')
 *   .whereHas('comments', (c) => c.where('approved', true));
 * ```
 */
export interface Conditions<Row = Record<string, unknown>> {
  /**
   * Every key equal to its value. A `null` value means `is null`; an array means `in`.
   * @param conditions - Columns and values: `{ status: 'open', owner_id: id }`.
   */
  where(conditions: Partial<Row> | Record<string, unknown>): this;
  /**
   * The column equals the value. `null` means `is null`; an array means `in`.
   * @param column - The column.
   * @param value - The value. A `Date` is sent as ISO 8601 text.
   */
  where(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * The column compared with the value: `where('likes', '>', 10)`.
   * @param column - The column.
   * @param op - The {@link Operator}.
   * @param value - The value. A `Date` is sent as ISO 8601 text.
   * @throws TypeError for an unknown operator.
   */
  where(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  /**
   * A group in parentheses: `where((q) => q.where('a', 1).orWhere('b', 2))`.
   * @param group - Gets an empty filter and returns it with conditions.
   */
  where(group: Grouper): this;
  /**
   * OR every key equal to its value.
   * @param conditions - Columns and values.
   */
  orWhere(conditions: Partial<Row> | Record<string, unknown>): this;
  /**
   * OR the column equals the value.
   * @param column - The column.
   * @param value - The value.
   */
  orWhere(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * OR the column compared with the value.
   * @param column - The column.
   * @param op - The {@link Operator}.
   * @param value - The value.
   */
  orWhere(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  /**
   * OR a group in parentheses.
   * @param group - Gets an empty filter and returns it with conditions.
   */
  orWhere(group: Grouper): this;
  /**
   * NOT (every key equal to its value).
   * @param conditions - Columns and values.
   */
  whereNot(conditions: Partial<Row> | Record<string, unknown>): this;
  /**
   * The column does not equal the value.
   * @param column - The column.
   * @param value - The value.
   */
  whereNot(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * NOT (the column compared with the value).
   * @param column - The column.
   * @param op - The {@link Operator}.
   * @param value - The value.
   */
  whereNot(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  /**
   * NOT (a group).
   * @param group - Gets an empty filter and returns it with conditions.
   */
  whereNot(group: Grouper): this;
  /**
   * OR NOT (the column compared with the value).
   * @param column - The column.
   * @param op - The {@link Operator}.
   * @param value - The value.
   */
  orWhereNot(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  /**
   * The column is one of the values, or one of a subquery's values (GORM's
   * `Where("author_id IN (?)", db.Table("profiles").Select("id"))`). The
   * subquery runs as the caller, under its table's row-level security.
   *
   * @param column - The column.
   * @param values - The allowed values, or a query selecting one column (the primary key when it selects none).
   * @throws TypeError when the subquery selects more than one column.
   *
   * @example
   * ```ts
   * await db.from('posts').whereIn('author_id', db.from('profiles').select('id').where('country', 'IN'));
   * ```
   */
  whereIn(column: Cols<Row> | (string & {}), values: unknown[] | Subquery): this;
  /**
   * The column is none of the values, or of a subquery's values.
   * @param column - The column.
   * @param values - The excluded values, or a query selecting one column.
   */
  whereNotIn(column: Cols<Row> | (string & {}), values: unknown[] | Subquery): this;
  /**
   * The column is null.
   * @param column - The column.
   */
  whereNull(column: Cols<Row> | (string & {})): this;
  /**
   * The column is not null.
   * @param column - The column.
   */
  whereNotNull(column: Cols<Row> | (string & {})): this;
  /**
   * `low <= column <= high`.
   * @param column - The column.
   * @param low - The lowest value, included.
   * @param high - The highest value, included.
   */
  whereBetween(column: Cols<Row> | (string & {}), low: unknown, high: unknown): this;
  /**
   * The column is outside `low` to `high`.
   * @param column - The column.
   * @param low - The lowest excluded value.
   * @param high - The highest excluded value.
   */
  whereNotBetween(column: Cols<Row> | (string & {}), low: unknown, high: unknown): this;
  /**
   * SQL `LIKE`, case-sensitive: `whereLike('name', 'As%')`.
   * @param column - The column.
   * @param pattern - The pattern, with `%` and `_` wildcards.
   */
  whereLike(column: Cols<Row> | (string & {}), pattern: string): this;
  /**
   * SQL `ILIKE`, case-insensitive.
   * @param column - The column.
   * @param pattern - The pattern, with `%` and `_` wildcards.
   */
  whereILike(column: Cols<Row> | (string & {}), pattern: string): this;
  /**
   * An array or JSON column contains the value (`@>`).
   * @param column - The column.
   * @param value - The array or object it must contain.
   */
  whereContains(column: Cols<Row> | (string & {}), value: Json): this;
  /**
   * An array column shares at least one element with the value (`&&`).
   * @param column - The column.
   * @param value - The elements to look for.
   */
  whereOverlaps(column: Cols<Row> | (string & {}), value: Json[]): this;
  /**
   * Full-text search, web-search syntax: `whereSearch('document', 'fast cars', 'english')`.
   * @param column - A text or tsvector column.
   * @param text - What to search for.
   * @param language - The text search configuration, such as `'english'`.
   */
  whereSearch(column: Cols<Row> | (string & {}), text: string, language?: string): this;
  /**
   * Inside a json/jsonb column, equal: `whereJson('meta', 'address.city', 'Chennai')`.
   * @param column - The json or jsonb column.
   * @param path - The keys to follow, as `'a.b'` or `['a', 'b']`.
   * @param value - The value to match.
   */
  whereJson(column: Cols<Row> | (string & {}), path: string | string[], value: unknown): this;
  /**
   * Inside a json/jsonb column, compared: `whereJson('meta', 'score', '>', 5)`.
   * @param column - The json or jsonb column.
   * @param path - The keys to follow, as `'a.b'` or `['a', 'b']`.
   * @param op - The {@link Operator}.
   * @param value - The value to compare with.
   */
  whereJson(column: Cols<Row> | (string & {}), path: string | string[], op: Operator, value: unknown): this;
  /**
   * A related row exists, optionally matching a filter (a filtered join):
   * `whereHas('comments', (c) => c.where('approved', true))`. Soft-deleted
   * related rows do not count.
   *
   * @param relation - A relation name from the model, or a related table name.
   * @param callback - Filters the related rows.
   */
  whereHas(relation: string, callback?: Grouper): this;
  /**
   * OR a related row exists.
   * @param relation - A relation name from the model, or a related table name.
   * @param callback - Filters the related rows.
   */
  orWhereHas(relation: string, callback?: Grouper): this;
  /**
   * No related row exists (that matches the filter).
   * @param relation - A relation name from the model, or a related table name.
   * @param callback - Filters the related rows.
   */
  whereDoesntHave(relation: string, callback?: Grouper): this;
  /**
   * Equal (Supabase's `eq`).
   * @param column - The column.
   * @param value - The value. `null` means `is null`.
   */
  eq(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * Not equal (Supabase's `neq`).
   * @param column - The column.
   * @param value - The value. `null` means `is not null`.
   */
  neq(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * Greater than.
   * @param column - The column.
   * @param value - The value.
   */
  gt(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * Greater than or equal.
   * @param column - The column.
   * @param value - The value.
   */
  gte(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * Less than.
   * @param column - The column.
   * @param value - The value.
   */
  lt(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * Less than or equal.
   * @param column - The column.
   * @param value - The value.
   */
  lte(column: Cols<Row> | (string & {}), value: unknown): this;
  /**
   * SQL `LIKE`, case-sensitive.
   * @param column - The column.
   * @param pattern - The pattern, with `%` and `_` wildcards.
   */
  like(column: Cols<Row> | (string & {}), pattern: string): this;
  /**
   * SQL `ILIKE`, case-insensitive.
   * @param column - The column.
   * @param pattern - The pattern, with `%` and `_` wildcards.
   */
  ilike(column: Cols<Row> | (string & {}), pattern: string): this;
  /**
   * SQL `IS`: `is('deleted_at', null)`, `is('done', true)`.
   * @param column - The column.
   * @param value - `null`, `true` or `false`.
   */
  is(column: Cols<Row> | (string & {}), value: boolean | null): this;
  /**
   * The column is one of the values.
   * @param column - The column.
   * @param values - The allowed values.
   */
  in(column: Cols<Row> | (string & {}), values: unknown[] | Subquery): this;
  /**
   * An array or JSON column contains the value (`@>`).
   * @param column - The column.
   * @param value - The array or object it must contain.
   */
  contains(column: Cols<Row> | (string & {}), value: Json): this;
  /**
   * An array or JSON column is contained by the value (`<@`).
   * @param column - The column.
   * @param value - The array or object that must contain it.
   */
  containedBy(column: Cols<Row> | (string & {}), value: Json): this;
  /**
   * An array column shares at least one element with the value (`&&`).
   * @param column - The column.
   * @param value - The elements to look for.
   */
  overlaps(column: Cols<Row> | (string & {}), value: Json[]): this;
  /**
   * Full-text search: `textSearch('body', 'fast & cars', { type: 'websearch', config: 'english' })`.
   * @param column - A text or tsvector column.
   * @param query - The search query.
   * @param options - `type`: `'plain'`, `'phrase'` or `'websearch'` (raw `to_tsquery` syntax when left out); `config`: the text search configuration.
   */
  textSearch(column: Cols<Row> | (string & {}), query: string, options?: { type?: 'plain' | 'phrase' | 'websearch'; config?: string }): this;
  /**
   * Every key equal to its value (Supabase's `match`).
   * @param values - Columns and values.
   */
  match(values: Partial<Row> | Record<string, unknown>): this;
  /**
   * NOT, with a Data API operator name: `not('status', 'eq', 'draft')`, `not('id', 'in', '(1,2)')`.
   * @param column - The column.
   * @param op - The operator by its Data API name (`eq`, `in`, `is`, `like`, …).
   * @param value - The value; an array becomes a list.
   */
  not(column: Cols<Row> | (string & {}), op: string, value: unknown): this;
  /**
   * OR conditions in Supabase's text syntax: `or('pinned.is.true,body.eq.Groceries')`.
   * Nest with `and(…)` and `or(…)`.
   * @param filters - Comma-separated `column.operator.value` conditions.
   * @throws TypeError when a condition cannot be read.
   */
  or(filters: string): this;
  /**
   * A condition with a Data API operator name: `filter('age', 'gte', 18)`.
   * Prefix with `not.` to negate.
   * @param column - The column.
   * @param op - The operator by its Data API name.
   * @param value - The value; an array becomes a list.
   */
  filter(column: Cols<Row> | (string & {}), op: string, value: unknown): this;
}

/** One ORDER BY term. */
export type OrderTerm = {
  /** The column to sort by (or to aggregate, with `fn`). */
  column?: string;
  /** Sort by a column of this to-one related table (many-to-one or one-to-one). */
  relation?: string;
  /** With `relation`: the foreign key constraint to join on, when there is more than one. */
  hint?: string;
  /** Sort by an aggregate, after `groupBy()`. */
  fn?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** `'asc'` (the default) or `'desc'`. */
  dir?: 'asc' | 'desc';
  /** Where nulls go. */
  nulls?: 'first' | 'last';
};

/**
 * `order()`: sorts by a column, adding to any order already set.
 *
 * - `order('created_at', 'desc')`, or `order('created_at desc')`
 * - `order('name', 'asc', { nulls: 'last' })`
 * - `order('created_at', { ascending: false, nullsFirst: true })` (Supabase)
 * - `order('count(*)', 'desc')` after `groupBy()`
 * - `order({ column: 'name', dir: 'asc' })`
 * - `order('profiles.username', 'desc')` or `order('username', { relation: 'profiles' })`:
 *   by a column of a to-one related row (GORM's `Joins("Author").Order("Author.name")`);
 *   the relation is a model relation name or a table name
 * - `order('created_at', { referencedTable: 'comments', ascending: false })`:
 *   sorts the rows of the `comments` embed instead (Supabase)
 *
 * Throws a `TypeError` for a direction other than `asc` or `desc`, or for a
 * `referencedTable` the query does not select or preload.
 */
type OrderMethod<B> = {
  /**
   * @param column - The column, optionally with the direction: `'created_at desc'`; `'relation.column'` for a related row's column.
   * @param dir - `'asc'` (the default) or `'desc'`.
   * @param options - Where nulls go; `relation` (and `hint`) for a related row's column; `referencedTable` to sort an embed's rows.
   */
  (column: string, dir?: 'asc' | 'desc', options?: { nulls?: 'first' | 'last'; relation?: string; hint?: string } & EmbedTarget): B;
  /**
   * @param column - The column.
   * @param options - Supabase's form: `ascending` and `nullsFirst`, `referencedTable`; and `relation` (with `hint`) for a related row's column.
   */
  (column: string, options: { ascending?: boolean; nullsFirst?: boolean; relation?: string; hint?: string } & EmbedTarget): B;
  /** @param term - The term, as the Data API takes it. */
  (term: OrderTerm): B;
};

/**
 * Related rows inside `preload()`, `joins()`, `withCount()` and
 * `withAggregate()`: their columns, filters, order, limits and their own
 * relations.
 */
export interface EmbedBuilder extends Conditions<any> {
  /**
   * The related rows' columns, and nested relations in Supabase's syntax.
   * @param columns - Column names, `'a, b'`, `'name as label'`, `{ label: 'name' }` or `'author:authors(name)'`.
   */
  select(...columns: Array<string | string[] | Record<string, string>>): this;
  /** Sorts the related rows. See {@link OrderMethod}. */
  order: OrderMethod<this>;
  /** Same as `order`. */
  orderBy: OrderMethod<this>;
  /**
   * Newest related rows first.
   * @param column - The column to sort by. `created_at` when left out.
   */
  latest(column?: string): this;
  /**
   * Oldest related rows first.
   * @param column - The column to sort by. `created_at` when left out.
   */
  oldest(column?: string): this;
  /**
   * At most `n` related rows per parent row.
   * @param n - The maximum.
   * @param options - `referencedTable`: limit a nested embed's rows instead.
   */
  limit(n: number, options?: EmbedTarget): this;
  /**
   * Skips the first `n` related rows.
   * @param n - How many to skip.
   * @param options - `referencedTable`: skip a nested embed's rows instead.
   */
  offset(n: number, options?: EmbedTarget): this;
  /**
   * Loads a nested relation, or a path of them: `preload('author.profile')`.
   * @param relation - A relation name, a related table name, or a dotted path of them.
   * @param callback - Shapes the nested rows (the last relation on a path).
   */
  preload(relation: string, callback?: Related): this;
  /**
   * Loads a nested relation and keeps only parents that have a matching row (an inner join).
   * @param relation - A relation name, or a related table name.
   * @param callback - Shapes and filters the nested rows.
   */
  joins(relation: string, callback?: Related): this;
  /**
   * Adds the number of nested related rows as `<relation>_count`.
   * @param relation - A relation name, or a related table name.
   * @param callback - Filters what is counted.
   * @param as - The field name to use instead.
   */
  withCount(relation: string, callback?: Related, as?: string): this;
  /**
   * Adds aggregates of nested related rows as `<relation>_aggregate`.
   * @param relation - A relation name, or a related table name.
   * @param spec - What to compute.
   * @param callback - Filters what is aggregated.
   * @param as - The field name to use instead.
   */
  withAggregate(relation: string, spec: AggregateSpec, callback?: Related, as?: string): this;
}

/** What {@link QueryBuilder.aggregate} computes. */
export type AggregateSpec = {
  /** Count the rows. */
  count?: boolean;
  /** Sum these columns. */
  sum?: string | string[];
  /** Average these columns. */
  avg?: string | string[];
  /** The smallest value of these columns. */
  min?: string | string[];
  /** The largest value of these columns. */
  max?: string | string[];
};

/** What {@link QueryBuilder.aggregate} returns, for the whole table or for one group. */
export type AggregateResult = {
  /** How many rows. */
  count?: number;
  /** Sums by column. Numeric sums come back as text, so no digit is lost. */
  sum?: Record<string, string | number | null>;
  /** Averages by column, as text, so no digit is lost. */
  avg?: Record<string, string | number | null>;
  /** Smallest values by column. */
  min?: Record<string, unknown>;
  /** Largest values by column. */
  max?: Record<string, unknown>;
};

/**
 * A query on one table: a chainable, immutable description of one operation,
 * run as the signed-in user under row-level security. Get one from
 * {@link PlexivoClient.from} or a {@link Model}.
 *
 * Every shaping method returns a new builder. Await a builder to run it: a
 * read gives a {@link Result} (an array that also has `data` and `count`);
 * `insert()`, `upsert()`, `update()` and `delete()` run the write they
 * describe. Or call a terminal method such as `first()`, `count()` or
 * `create()`.
 *
 * A read returns at most 1,000 rows per request; use `paginate()`,
 * `findInBatches()` or `for await` for more.
 *
 * @example Filters, order and pagination
 * ```ts
 * const page = await db.from('posts')
 *   .select('id', 'title', 'author:authors(name)')
 *   .where('likes', '>', 10)
 *   .orWhere({ featured: true })
 *   .order('created_at', 'desc')
 *   .page(2, 20);
 *
 * const { data, count } = await db.from('notes')
 *   .select('id, body', { count: 'exact' })
 *   .eq('pinned', true)
 *   .range(0, 9);
 *
 * const { data: rows, total, totalPages } = await db.from('posts').latest().paginate({ page: 1, perPage: 20 });
 * ```
 *
 * @example Writes
 * ```ts
 * const post = await db.from('posts').create({ title: 'Hello' });
 * await db.from('posts').where('id', post.id).update({ title: 'Hello again' });
 * await db.from('posts').where('views', '<', 1).delete();
 * await db.from('products').where('sku', 'B2').decrement('stock');
 * ```
 */
export interface QueryBuilder<Row = Record<string, unknown>, Insert = Partial<Row>, Update = Partial<Row>, Throws extends boolean = true>
  extends Conditions<Row>, PromiseLike<Outcome<Result<Row>, Throws>> {
  /** The table this builder queries. */
  readonly table: string;
  /**
   * Runs the builder and handles a failure.
   * @param onrejected - Called with the error.
   */
  catch<T = never>(onrejected?: (reason: any) => T | PromiseLike<T>): Promise<Outcome<Result<Row>, Throws> | T>;
  /**
   * Runs the builder and calls `onfinally` when it settles.
   * @param onfinally - Called on success or failure.
   */
  finally(onfinally?: () => void): Promise<Outcome<Result<Row>, Throws>>;
  /**
   * Cancels the request when `signal` aborts; it then fails with a
   * {@link PlexivoError} coded `aborted`.
   * @param signal - An `AbortController`'s signal.
   *
   * @example
   * ```ts
   * const controller = new AbortController();
   * setTimeout(() => controller.abort(), 5000);
   * const rows = await db.from('posts').abortSignal(controller.signal);
   * ```
   */
  abortSignal(signal: AbortSignal): this;
  // shaping
  /**
   * The columns to return, and related rows in Supabase's syntax. Pass
   * `{ count: 'exact' }` last to also get the total matching count, and
   * `head: true` for the count alone.
   *
   * @param columns - Column names, `'a, b'`, `'name as label'`, `{ label: 'name' }`, `'author:authors(name)'`, `'comments!inner(id)'`, `'comments(count)'`.
   * @throws TypeError when an item cannot be read.
   */
  select(...columns: Array<string | string[] | Record<string, string> | { count?: 'exact'; head?: boolean }>): this;
  /** Sorts the rows, adding to any order already set. See {@link OrderMethod}. */
  order: OrderMethod<this>;
  /** Same as `order`. */
  orderBy: OrderMethod<this>;
  /**
   * Newest first.
   * @param column - The column to sort by. `created_at` when left out.
   */
  latest(column?: string): this;
  /**
   * Oldest first.
   * @param column - The column to sort by. `created_at` when left out.
   */
  oldest(column?: string): this;
  /**
   * At most `n` rows.
   * @param n - The maximum (the server returns at most 1,000 per request).
   * @param options - `referencedTable`: at most `n` rows of that embed per row instead.
   */
  limit(n: number, options?: EmbedTarget): this;
  /**
   * Skips the first `n` rows.
   * @param n - How many to skip.
   * @param options - `referencedTable`: skip that embed's rows instead.
   */
  offset(n: number, options?: EmbedTarget): this;
  /**
   * One page of rows: sets `limit` and `offset`.
   * @param number - The page, from 1.
   * @param size - Rows per page. 20 when left out.
   */
  page(number: number, size?: number): this;
  /**
   * Rows `from` to `to`, inclusive and zero-based (Supabase's `range`).
   * @param from - The first row.
   * @param to - The last row.
   */
  range(from: number, to: number): this;
  /**
   * Only distinct rows, or distinct on these columns.
   * @param columns - The columns, or none for whole rows.
   */
  distinct(...columns: string[]): this;
  /**
   * Loads related rows into each row (GORM's Preload): `preload('author')`,
   * `preload('comments', (c) => c.where('approved', true).latest().limit(5))`.
   * A belongs-to or has-one relation gives an object (or `null`); has-many
   * and many-to-many give an array.
   *
   * A dotted path loads nested relations (GORM's `Preload("Comments.Author")`):
   * `preload('comments.author')`; the callback shapes the last relation on
   * the path, and a path merges into a preload of its first relation.
   *
   * @param relation - A relation name from the model, a related table name (`'authors!posts_author_id_fkey'` to pick a foreign key), or a dotted path of them.
   * @param callback - Shapes the related rows.
   */
  preload(relation: string, callback?: Related): this;
  /**
   * Like `preload`, but keeps only rows that have a matching related row (an inner join).
   * @param relation - A relation name from the model, or a related table name.
   * @param callback - Shapes and filters the related rows.
   */
  joins(relation: string, callback?: Related): this;
  /**
   * Adds the number of related rows to each row, as `<relation>_count`.
   * @param relation - A relation name from the model, or a related table name.
   * @param callback - Filters what is counted.
   * @param as - The field name to use instead.
   */
  withCount(relation: string, callback?: Related, as?: string): this;
  /**
   * Adds aggregates of related rows to each row, as `<relation>_aggregate`.
   * @param relation - A relation name from the model, or a related table name.
   * @param spec - What to compute.
   * @param callback - Filters what is aggregated.
   * @param as - The field name to use instead.
   */
  withAggregate(relation: string, spec: AggregateSpec, callback?: Related, as?: string): this;
  /**
   * A row lock on the rows read, held until the transaction commits. Use it
   * inside {@link PlexivoClient.transaction}.
   * @param strength - `'update'` (the default), `'no_key_update'`, `'share'` or `'key_share'`.
   * @param wait - `'nowait'` to fail at once, or `'skip_locked'` to skip locked rows.
   */
  lock(strength?: 'update' | 'no_key_update' | 'share' | 'key_share', wait?: 'nowait' | 'skip_locked'): this;
  /**
   * `FOR UPDATE`, inside a transaction.
   * @param options - `nowait` or `skipLocked`.
   */
  lockForUpdate(options?: { nowait?: boolean; skipLocked?: boolean }): this;
  /**
   * `FOR SHARE`, inside a transaction.
   * @param options - `nowait` or `skipLocked`.
   */
  forShare(options?: { nowait?: boolean; skipLocked?: boolean }): this;
  /**
   * GROUP BY, then {@link QueryBuilder.aggregate}: `groupBy('author_id').having('count', '>', 1).aggregate()`.
   * @param columns - The columns to group by.
   */
  groupBy(...columns: string[]): this;
  /**
   * Same as `groupBy`.
   * @param columns - The columns to group by.
   */
  group(...columns: string[]): this;
  /**
   * HAVING on the row count: `having('count', '>', 1)`.
   * @param fn - `'count'`.
   * @param op - The {@link Operator}.
   * @param value - The value to compare with.
   */
  having(fn: 'count', op: Operator, value: number): this;
  /**
   * HAVING on an aggregate of a column: `having('sum', 'likes', '>=', 100)`.
   * @param fn - The aggregate.
   * @param column - The column.
   * @param op - The {@link Operator}.
   * @param value - The value to compare with.
   */
  having(fn: 'sum' | 'avg' | 'min' | 'max', column: string, op: Operator, value: unknown): this;
  /**
   * HAVING as text with one placeholder: `having('sum(likes) > ?', 100)`.
   * @param expression - `fn(column) op ?`.
   * @param value - The value for `?`.
   * @throws TypeError when the expression cannot be read.
   */
  having(expression: string, value: unknown): this;
  /**
   * Applies reusable query pieces: functions, or the model's named scopes.
   * @param scopes - Scope names or `(q) => q.where(…)` functions.
   * @throws TypeError for a scope name the model does not have.
   */
  scopes(...scopes: Array<string | ((q: this) => this | void)>): this;
  /**
   * Same as `scopes`.
   * @param scopes - Scope names or functions.
   */
  scope(...scopes: Array<string | ((q: this) => this | void)>): this;
  /** Includes soft-deleted rows (GORM's Unscoped). With `delete()`, deletes for good. */
  unscoped(): this;
  /** Only soft-deleted rows. */
  onlyTrashed(): this;
  /** Lets `update()` and `delete()` touch every row (GORM's AllowGlobalUpdate). Without it, a write with no filter is refused with `missing_where`. */
  allowGlobalUpdate(): this;
  /**
   * Exactly one row, as `{ data }`.
   * Rejects with {@link RecordNotFoundError} when none match, and with a
   * {@link PlexivoError} coded `multiple_rows` when several do.
   */
  single(): PromiseLike<Outcome<SingleResult<Row>, Throws>>;
  /**
   * One row or `{ data: null }`.
   * Rejects with a {@link PlexivoError} coded `multiple_rows` when several match.
   */
  maybeSingle(): PromiseLike<Outcome<SingleResult<Row>, Throws>>;
  /**
   * What a write returns: `'representation'` (the default) for the rows,
   * `'minimal'` for only the count.
   * @param mode - `'minimal'` or `'representation'`.
   */
  returning(mode: 'minimal' | 'representation'): this;
  /** The structured select operation this builder sends, without running it (GORM's DryRun). */
  toQuery(): Record<string, unknown>;
  // reading
  /**
   * The matching rows (up to the limit; at most 1,000 per request).
   * @param ids - Primary key values to look up instead.
   */
  find(ids?: unknown): Promise<Result<Row>>;
  /**
   * The matching rows, or the rows with these primary keys.
   *
   * Called directly on `db.from(table)` or on a model with exactly one id,
   * this is the 0.1 form: it resolves to that one row, and rejects with a
   * {@link PlexivoError} coded `not_found` when there is none.
   *
   * @param ids - Primary key values.
   */
  get(...ids: unknown[]): Promise<Result<Row>>;
  /**
   * The first row by primary key (or by your `order()`). `first(id)` looks one up by primary key.
   * @param id - A primary key value.
   * @throws {@link RecordNotFoundError} when no row matches.
   */
  first(id?: unknown): Promise<Row>;
  /**
   * The last row by primary key (or by your `order()`, reversed).
   * @throws {@link RecordNotFoundError} when no row matches.
   */
  last(): Promise<Row>;
  /**
   * Any one matching row, in no particular order.
   * @throws {@link RecordNotFoundError} when no row matches.
   */
  take(): Promise<Row>;
  /**
   * Like `first()`, but `null` instead of an error.
   * @param id - A primary key value.
   */
  firstOrNull(id?: unknown): Promise<Row | null>;
  /**
   * Exactly one row, for lookups that must be unique.
   * @throws {@link RecordNotFoundError} when no row matches.
   * @throws {@link PlexivoError} coded `multiple_rows` when more than one does.
   */
  sole(): Promise<Row>;
  /**
   * One column's values: `pluck('email')`.
   * @param column - The column.
   */
  pluck<K extends Cols<Row>>(column: K): Promise<Array<Row[K]>>;
  /**
   * One column's values.
   * @param column - The column.
   */
  pluck(column: string): Promise<unknown[]>;
  /** How many rows match (ignores `limit`). */
  count(): Promise<number>;
  /** Whether any row matches. */
  exists(): Promise<boolean>;
  /**
   * The sum of a column, as a number, or `null` when no rows match.
   * @param column - The column.
   */
  sum(column: string): Promise<number | null>;
  /**
   * The average of a column, as a number, or `null` when no rows match.
   * @param column - The column.
   */
  avg(column: string): Promise<number | null>;
  /**
   * The smallest value of a column, or `null`.
   * @param column - The column.
   */
  min(column: string): Promise<unknown>;
  /**
   * The largest value of a column, or `null`.
   * @param column - The column.
   */
  max(column: string): Promise<unknown>;
  /**
   * Aggregates of the matching rows: an {@link AggregateResult}. After
   * `groupBy()`, an array with one object per group, with its group columns.
   *
   * @param spec - What to compute. `{ count: true }` when left out.
   *
   * @example
   * ```ts
   * await db.from('posts').where('published', true).aggregate({ count: true, avg: 'likes' });
   * await db.from('posts').groupBy('author_id').having('count', '>', 1)
   *   .order('count(*)', 'desc').aggregate({ count: true, sum: 'likes' });
   * // → [{ author_id: 1, count: 2, sum: { likes: '165' } }, …]
   * ```
   */
  aggregate(spec?: AggregateSpec): Promise<any>;
  /**
   * One page of rows with the total count.
   * @param options - `page` (from 1) and `perPage` (20 when left out).
   */
  paginate(options?: { page?: number; perPage?: number }): Promise<{
    /** This page's rows. */
    data: Row[];
    /** How many rows match in all. */
    total: number;
    /** This page's number. */
    page: number;
    /** Rows per page. */
    perPage: number;
    /** How many pages there are (at least 1). */
    totalPages: number;
  }>;
  /**
   * Every matching row in batches (GORM's FindInBatches), by primary key with
   * a key cursor, so rows are neither skipped nor repeated while you work.
   * Return `false` from the callback to stop.
   *
   * @param size - Rows per batch (at most 1,000).
   * @param callback - Gets each batch and its number, from 0.
   * @throws Error when the primary key is not among the selected columns.
   */
  findInBatches(size: number, callback: (rows: Row[], batch: number) => unknown): Promise<void>;
  /**
   * Every matching row, one at a time, read in batches of 500. Return `false` to stop.
   * @param callback - Gets each row.
   */
  each(callback: (row: Row) => unknown): Promise<void>;
  /** `for await (const row of query)`: every matching row, read by primary key in batches of 500. */
  [Symbol.asyncIterator](): AsyncIterator<Row>;
  // writing
  /**
   * Inserts one row and returns it, running the model's `beforeSave`,
   * `beforeCreate`, `afterCreate` and `afterSave` hooks. More than 1,000 rows
   * go in batches of 1,000, which is not atomic; use a transaction to make it so.
   *
   * @param values - The row.
   * @param options - `omit` or `only` these keys.
   */
  create(values: Insert, options?: { omit?: string[]; only?: string[] }): Promise<Row>;
  /**
   * Inserts several rows and returns them.
   * @param values - The rows.
   * @param options - `omit` or `only` these keys.
   */
  create(values: Insert[], options?: { omit?: string[]; only?: string[] }): Promise<Row[]>;
  /**
   * Inserts and returns only the number of rows inserted.
   * @param values - The row or rows.
   * @param options - `returning: 'minimal'`, and `omit` or `only` these keys.
   */
  create(values: Insert | Insert[], options: { returning: 'minimal'; omit?: string[]; only?: string[] }): Promise<number>;
  /**
   * Inserts `size` rows per request (GORM's CreateInBatches). Not atomic.
   * @param values - The rows.
   * @param size - Rows per request. 100 when left out.
   */
  createInBatches(values: Insert[], size?: number): Promise<Row[]>;
  /**
   * Supabase's insert: describes the insert; await it for the inserted rows
   * as a {@link Result}.
   * @param values - A row or rows.
   * @param options - `returning: 'minimal'` for only the count.
   */
  insert(values: Insert | Insert[], options?: { returning?: 'minimal' }): QueryBuilder<Row, Insert, Update, Throws>;
  /**
   * Inserts, or on conflict updates: `upsert(rows, { onConflict: ['sku'], update: ['price'] })`.
   * Await it for the rows. Runs `beforeSave` and `afterSave` hooks.
   *
   * @param values - A row or rows.
   * @param options - `onConflict`: the unique columns (the primary key when left out); `update`: the columns to update (all when left out), or `false` to leave the existing row untouched; `ignore` or `ignoreDuplicates`: same as `update: false`; `returning: 'minimal'` for only the count.
   */
  upsert(values: Insert | Insert[], options?: { onConflict?: string | string[]; update?: string[] | false; ignore?: boolean; ignoreDuplicates?: boolean; returning?: 'minimal' }): QueryBuilder<Row, Insert, Update, Throws>;
  /**
   * GORM's Save: inserts a row without a primary key; otherwise inserts or
   * updates every column it carries.
   * @param row - The row.
   * @returns The saved row.
   */
  save(row: Insert | Row): Promise<Row>;
  /**
   * The 0.1 form: updates one row by primary key.
   * @param id - The primary key value.
   * @param values - The columns to change.
   * @returns The updated row.
   * @throws {@link RecordNotFoundError} when there is no such row.
   */
  update(id: string | number, values: Update): Promise<Row>;
  /**
   * Updates the matching rows; await it for them. A filter is required.
   * Runs `beforeSave`, `beforeUpdate`, `afterUpdate` and `afterSave` hooks.
   *
   * Awaiting rejects with a {@link PlexivoError} coded `missing_where` when
   * there is no filter and no `allowGlobalUpdate()`.
   *
   * @param values - The columns to change.
   * @param _ - Leave out.
   * @param options - `returning: 'minimal'` for only the count.
   */
  update(values: Update, _?: undefined, options?: { returning?: 'minimal' }): QueryBuilder<Row, Insert, Update, Throws>;
  /**
   * Updates one column of the matching rows: `updateColumn('status', 'archived')`. A filter is required.
   * @param column - The column.
   * @param value - Its new value.
   */
  updateColumn(column: string, value: unknown): QueryBuilder<Row, Insert, Update, Throws>;
  /**
   * Adds to a counter in the database, atomically: `increment('views')`.
   * A filter is required; rejects with `missing_where` without one.
   * @param column - The counter column.
   * @param by - How much to add. 1 when left out.
   * @param extra - Other columns to set at the same time.
   * @returns The updated rows.
   */
  increment(column: string, by?: number, extra?: Update): Promise<Result<Row>>;
  /**
   * Subtracts from a counter in the database, atomically: `decrement('stock', 2)`.
   * A filter is required; rejects with `missing_where` without one.
   * @param column - The counter column.
   * @param by - How much to subtract. 1 when left out.
   * @param extra - Other columns to set at the same time.
   * @returns The updated rows.
   */
  decrement(column: string, by?: number, extra?: Update): Promise<Result<Row>>;
  /**
   * Deletes one row by primary key (soft-deletes it when the model has a soft-delete column).
   * @param id - The primary key value.
   * @returns The deleted row.
   * @throws {@link RecordNotFoundError} when there is no such row.
   */
  delete(id: string | number): Promise<Row>;
  /**
   * Deletes the matching rows; await it for them. A filter is required. With a
   * soft-delete column, sets it to now instead (add `unscoped()` to delete for
   * good). Runs `beforeDelete` and `afterDelete` hooks.
   *
   * Awaiting rejects with a {@link PlexivoError} coded `missing_where` when
   * there is no filter and no `allowGlobalUpdate()`.
   *
   * @param options - `returning: 'minimal'` for only the count.
   */
  delete(options?: { returning?: 'minimal' }): QueryBuilder<Row, Insert, Update, Throws>;
  /** Deletes the matching rows for good, even with a soft-delete column. A filter is required. */
  forceDelete(): Promise<Result<Row>>;
  /**
   * Brings back the matching soft-deleted rows.
   * @throws Error when the table has no soft-delete column.
   */
  restore(): Promise<Result<Row>>;
  /**
   * The first row matching `attributes`, or a new one created from them and `defaults`.
   * @param attributes - The columns to match.
   * @param defaults - More columns for a new row.
   */
  firstOrCreate(attributes: Partial<Row>, defaults?: Partial<Insert>): Promise<Row>;
  /**
   * The first row matching `attributes`, or (not saved) `attributes` and `defaults`.
   * @param attributes - The columns to match.
   * @param defaults - More columns for the unsaved row.
   */
  firstOrInit(attributes: Partial<Row>, defaults?: Partial<Insert>): Promise<Row | Partial<Row>>;
  /**
   * Updates the rows matching `attributes` with `values` and returns the
   * first, or creates a row from both.
   * @param attributes - The columns to match.
   * @param values - The columns to set.
   */
  updateOrCreate(attributes: Partial<Row>, values?: Update): Promise<Row>;
}

// ── models ─────────────────────────────────────────────────────────────────

/**
 * How two tables relate, for a model's `relations`. Make one with
 * {@link belongsTo}, {@link hasOne}, {@link hasMany} or {@link manyToMany}.
 */
export type Relation =
  | {
    /** This table holds the foreign key. */
    kind: 'belongsTo';
    /** The related table. */
    table: string;
    /** The column on this table that points at the related row. */
    foreignKey?: string;
    /** The related table's key column, when it is not its primary key. */
    references?: string;
    /** The foreign key constraint to join on, when there is more than one. */
    constraint?: string;
  }
  | {
    /** The related table holds the foreign key: one row (`hasOne`) or many (`hasMany`). */
    kind: 'hasOne' | 'hasMany';
    /** The related table. */
    table: string;
    /** The column on the related table that points back here. */
    foreignKey?: string;
    /** This table's key column, when it is not its primary key. */
    references?: string;
    /** The foreign key constraint to join on, when there is more than one. */
    constraint?: string;
  }
  | {
    /** Related through a link table. */
    kind: 'manyToMany';
    /** The related table. */
    table: string;
    /** The link table. */
    through: string;
    /** The link table's column that points at this table. */
    foreignKey: string;
    /** The link table's column that points at the related table. */
    otherKey: string;
    /** The link-to-related foreign key constraint, when there is more than one. */
    constraint?: string;
    /** The link-to-this-table foreign key constraint, when there is more than one. */
    throughConstraint?: string;
  };

/**
 * This table holds the foreign key: `posts.author_id → authors.id`.
 * `foreignKey` is needed for association mode.
 *
 * @param table - The related table.
 * @param options - `foreignKey` (the column here), `references` and `constraint`.
 *
 * @example
 * ```ts
 * const Post = db.model('posts', { relations: { author: belongsTo('authors', { foreignKey: 'author_id' }) } });
 * ```
 */
export function belongsTo(table: string, options?: { foreignKey?: string; references?: string; constraint?: string }): Relation;
/**
 * The other table holds the foreign key, one row per row here:
 * `users.id ← profiles.user_id`. Preloads as an object or `null`.
 *
 * @param table - The related table.
 * @param options - `foreignKey` (the column on the related table), `references` and `constraint`.
 */
export function hasOne(table: string, options?: { foreignKey?: string; references?: string; constraint?: string }): Relation;
/**
 * The other table holds the foreign key, many rows per row here:
 * `posts.id ← comments.post_id`. Preloads as an array.
 *
 * @param table - The related table.
 * @param options - `foreignKey` (the column on the related table), `references` and `constraint`.
 */
export function hasMany(table: string, options?: { foreignKey?: string; references?: string; constraint?: string }): Relation;
/**
 * Related through a link table: `posts ⇄ post_tags ⇄ tags`. Preloads as an array.
 *
 * @param table - The related table.
 * @param options - `through` (the link table), `foreignKey` and `otherKey` (its columns), and the optional constraint names.
 * @throws TypeError without `through`.
 *
 * @example
 * ```ts
 * tags: manyToMany('tags', { through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id' })
 * ```
 */
export function manyToMany(table: string, options: { through: string; foreignKey: string; otherKey: string; constraint?: string; throughConstraint?: string }): Relation;

/**
 * A column, for migrations: SQL (`'text not null'`) or its parts.
 * `default` and `check` are SQL, as GORM's tags are.
 */
export type ColumnDef = string | {
  /** The SQL type: `'text'`, `'bigint'`, `'timestamptz'`, `'jsonb'`, … */
  type: string;
  /** The primary key. */
  primaryKey?: boolean;
  /** `GENERATED BY DEFAULT AS IDENTITY`. */
  identity?: boolean;
  /** `NOT NULL`. */
  notNull?: boolean;
  /** `false` is the same as `notNull: true`. */
  nullable?: boolean;
  /** `UNIQUE`. */
  unique?: boolean;
  /** SQL, as GORM's default tag: "now()", "0", "'draft'". */
  default?: string | number | boolean | null;
  /** A `CHECK` expression, in SQL. */
  check?: string;
  /** A foreign key: `'authors(id)'` or `'authors.id'`. */
  references?: string;
  /** What happens to this row when the referenced row is deleted. */
  onDelete?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
  /** What happens to this row when the referenced key changes. */
  onUpdate?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
  /** An index on this column: `true`, or its options. */
  index?: boolean | {
    /** A unique index. */
    unique?: boolean;
    /** The index name. Made from the table and column when left out. */
    name?: string;
    /** The index method, such as `'gin'`. */
    using?: string;
    /** A partial index condition, in SQL. */
    where?: string;
  };
};

/** An index, for migrations. */
export type IndexDef = {
  /** The column or columns. An expression such as `'lower(email)'` is used as written. */
  columns: string | string[];
  /** A unique index. */
  unique?: boolean;
  /** The index name. Made from the table and columns when left out. */
  name?: string;
  /** The index method, such as `'gin'` or `'btree'`. */
  using?: string;
  /** A partial index condition, in SQL. */
  where?: string;
};

/** A row-level security policy, for migrations. */
export type PolicyDef = {
  /** The policy name. */
  name: string;
  /** The command it covers. `'all'` when left out. */
  for?: 'all' | 'select' | 'insert' | 'update' | 'delete';
  /** The roles it applies to: `'anon'`, `'authenticated'` (the default) or others. */
  to?: string | string[];
  /** Which existing rows are visible, in SQL: `'owner_id = auth.uid()'`. */
  using?: string;
  /** Which new or changed rows are allowed, in SQL. */
  check?: string;
  /** `'permissive'` (the default) or `'restrictive'`. */
  as?: 'permissive' | 'restrictive';
};

/**
 * Model hooks, as in GORM. A `before…` hook may return a changed row to use
 * instead; throwing from any hook stops the operation. Hooks may be async.
 */
export type Hooks<Row> = {
  /**
   * Before every insert, update, upsert or save.
   * @param row - The row or update values. Return a changed copy to use it.
   */
  beforeSave?(row: any): any;
  /**
   * Before an insert, after `beforeSave`.
   * @param row - The row. Return a changed copy to use it.
   */
  beforeCreate?(row: any): any;
  /**
   * After an insert, for each inserted row.
   * @param row - The inserted row.
   */
  afterCreate?(row: Row): unknown;
  /**
   * Before an update, after `beforeSave`.
   * @param values - The columns being set. Return a changed copy to use it.
   */
  beforeUpdate?(values: any): any;
  /**
   * After an update, for each updated row.
   * @param row - The updated row.
   */
  afterUpdate?(row: Row): unknown;
  /**
   * After every insert, update, upsert or save, for each row.
   * @param row - The saved row.
   */
  afterSave?(row: Row): unknown;
  /**
   * Before a delete. Throw to stop it.
   * @param query - The select operation describing the rows to delete.
   */
  beforeDelete?(query: Record<string, unknown>): unknown;
  /**
   * After a delete, for each deleted row.
   * @param row - The deleted row.
   */
  afterDelete?(row: Row): unknown;
  /**
   * After a read, for each row.
   * @param row - The row read. Return a changed copy to use it.
   */
  afterFind?(row: Row): any;
};

/** What a model knows about its table. See {@link PlexivoClient.model}. */
export type ModelOptions<Row = Record<string, unknown>> = {
  /** The primary key column. `'id'` when left out. An array declares a composite key for migrations only; lookups by key need one column. */
  primaryKey?: string | string[];
  /** The soft-delete column (such as `'deleted_at'`): deletes set it, and reads skip rows where it is set. */
  softDelete?: string;
  /** Named relations, for `preload`, `whereHas`, `withCount` and association mode. */
  relations?: Record<string, Relation>;
  /** Hooks around reads and writes. */
  hooks?: Hooks<Row>;
  /** Named, reusable query pieces, for `scopes('published')`. */
  scopes?: Record<string, (q: QueryBuilder<Row, any, any>) => QueryBuilder<Row, any, any> | void>;
  /** The table's columns, for {@link Migrator.autoMigrate} and `createTable`. */
  columns?: Record<string, ColumnDef>;
  /** More indexes, for migrations. */
  indexes?: IndexDef[];
  /** Unique constraints over one or more columns, for migrations. */
  uniques?: Array<string | string[]>;
  /** Table `CHECK` constraints in SQL, for migrations. */
  checks?: string[];
  /** Row-level security policies, for migrations. */
  policies?: PolicyDef[];
  /** Turn row-level security on, for migrations. On by default when there are policies. */
  rowLevelSecurity?: boolean;
};

/**
 * GORM's association mode for one row's relation. Multi-step changes run in
 * one transaction. Get one from {@link Model}'s `association(row, name)`.
 *
 * @example
 * ```ts
 * const tags = Post.association(post, 'tags');
 * await tags.append([elixir, postgres]);
 * await tags.count();
 * ```
 */
export interface Association<Related = Record<string, unknown>> {
  /**
   * The related rows. For a belongs-to relation, the one related row or
   * `null`, and `callback` is not used.
   * @param callback - Refines the query on the related rows.
   */
  find(callback?: (q: QueryBuilder<Related>) => QueryBuilder<Related>): Promise<Related[]>;
  /**
   * Links rows (or keys) to this row. New rows without a primary key are created first.
   * @param related - A row, a key, or a list of them.
   */
  append(related: unknown): Promise<unknown>;
  /**
   * Links exactly these rows, unlinking the rest.
   * @param related - A row, a key, or a list of them.
   */
  replace(related: unknown): Promise<unknown>;
  /**
   * Unlinks these rows. The related rows themselves are kept.
   * @param related - A row, a key, or a list of them. Not used for belongs-to.
   */
  delete(related?: unknown): Promise<unknown>;
  /** Unlinks every related row. The related rows themselves are kept. */
  clear(): Promise<unknown>;
  /** How many rows are linked. */
  count(): Promise<number>;
}

/**
 * A model: a table with its relations, hooks, scopes, soft deletes and
 * columns, and GORM-style shortcuts to every query method:
 * `Post.where(…)`, `Post.first(1)`, `Post.create({…})`.
 *
 * Make one with {@link PlexivoClient.model}. Once defined, `db.from(table)`
 * uses it too.
 */
export type Model<Row = Record<string, unknown>, Insert = Partial<Row>, Update = Partial<Row>> =
  Omit<ModelOptions<Row>, 'scopes'> & {
    /** The table. */
    table: string;
    /** The named scopes you defined. Apply them with `query().scopes('name')`. */
    scopes?: ModelOptions<Row>['scopes'];
    /** A new query on the table. */
    query(): QueryBuilder<Row, Insert, Update>;
    /**
     * Association mode for one row's relation.
     * @param row - The row, or its primary key.
     * @param relation - The relation name.
     * @throws TypeError for an unknown relation, or a row without a primary key.
     */
    association(row: unknown, relation: string): Association;
  } & Omit<QueryBuilder<Row, Insert, Update>, 'table' | 'then' | 'catch' | 'finally' | 'scopes' | typeof Symbol.asyncIterator>;

// ── transactions ───────────────────────────────────────────────────────────

/** A reference to an earlier operation's result, from {@link TxHandle}. */
export type Ref = {
  /** The path to the value: operation index, then keys. */
  $ref: string;
};

/**
 * The `tx` in {@link PlexivoClient.transaction}. Its queries work as usual,
 * but each operation is recorded, not sent, and returns a {@link TxHandle}.
 * In TypeScript, cast a write to `TxHandle<Row>` to use `.ref()`.
 */
export interface TransactionClient<TDatabase extends DatabaseDefinition = DefaultDatabase> {
  /**
   * A query on one table, recorded into the transaction.
   * @param table - The table name.
   */
  from<TName extends TableName<TDatabase>>(table: TName): TxQueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  /**
   * Same as `from`.
   * @param table - The table name.
   */
  table<TName extends TableName<TDatabase>>(table: TName): TxQueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  /**
   * Records a database function call into the transaction.
   * @param fn - The function name.
   * @param args - Its arguments, by name (values may hold refs).
   * @returns A handle resolving to `{ data, count, error: null }`.
   */
  rpc<T = any>(fn: string, args?: Record<string, unknown>): TxHandle<RpcResult<T>>;
}
/** Values whose columns may also be a {@link Ref} to an earlier operation's result. */
export type WithRefs<T> = { [K in keyof T]: T[K] | Ref };
/**
 * A query builder inside {@link PlexivoClient.transaction}: the same builder,
 * but `create` records the insert and returns a {@link TxHandle}, so a later
 * operation can use its result with `handle.ref('id')`, and values may hold refs.
 */
export interface TxQueryBuilder<Row = Record<string, unknown>, Insert = Partial<Row>, Update = Partial<Row>>
  extends QueryBuilder<Row, Insert, Update> {
  /**
   * Records an insert of one or more rows (values may hold refs).
   * @param values - The row, or rows.
   * @param options - `returning: 'minimal'` for the count only; `omit` / `only` keys.
   * @returns A handle: await it after the transaction, or pass `handle.ref('column')` on.
   */
  create(values: WithRefs<Insert>, options?: { omit?: string[]; only?: string[] }): TxHandle<Row>;
  create(values: WithRefs<Insert>[], options?: { omit?: string[]; only?: string[] }): TxHandle<Row[]>;
  create(values: WithRefs<Insert> | WithRefs<Insert>[], options: { returning: 'minimal'; omit?: string[]; only?: string[] }): TxHandle<number>;
}
/**
 * Inside `transaction()`, every operation returns a handle: await it after
 * the transaction, or pass `handle.ref('id')` to a later operation.
 */
export type TxHandle<T = unknown> = Promise<T> & {
  /**
   * A reference to a field of this operation's (first) row.
   * @param path - The column, or a dotted path. The whole row when left out.
   */
  ref(path?: string): Ref;
  /**
   * A reference to this operation's whole result.
   * @param path - A dotted path inside the result.
   */
  refAll(path?: string): Ref;
};

// ── raw SQL and migrations (server, secret key) ────────────────────────────

/** One statement's result, from raw SQL and migrations. */
export type SqlResult = {
  /** The SQL command, such as `'SELECT'` or `'INSERT'`. */
  command: string | null;
  /** The column names. */
  columns: string[];
  /** The rows, or `null` for a statement that returns none. */
  rows: Record<string, unknown>[] | null;
  /** How many rows it returned or changed. */
  row_count: number;
  /** `true` when the server returned only part of the rows. */
  truncated: boolean;
};

/**
 * Schema changes collected to run together, in one transaction. A function
 * migration gets one; so does {@link Migrator.plan}. Every method returns the
 * plan, so calls chain.
 */
export interface MigrationPlan {
  /** The statements collected so far. */
  statements: Array<{
    /** The SQL. */
    sql: string;
    /** Its `$1`, `$2` … parameters. */
    params: unknown[];
  }>;
  /**
   * Any SQL statement.
   * @param text - The SQL, with `$1`, `$2` … parameters.
   * @param params - The parameters.
   */
  sql(text: string, params?: unknown[]): MigrationPlan;
  /**
   * `CREATE TABLE IF NOT EXISTS`, with its indexes, row-level security and policies.
   * @param table - The table name.
   * @param columns - The columns.
   * @param options - Indexes, uniques, checks, policies, a composite primary key.
   */
  createTable(table: string, columns: Record<string, ColumnDef>, options?: ModelOptions): MigrationPlan;
  /**
   * `DROP TABLE`.
   * @param table - The table name.
   * @param options - `ifExists` (default `true`) and `cascade`.
   */
  dropTable(table: string, options?: { ifExists?: boolean; cascade?: boolean }): MigrationPlan;
  /**
   * `ADD COLUMN IF NOT EXISTS`.
   * @param table - The table.
   * @param name - The column name.
   * @param def - The column.
   */
  addColumn(table: string, name: string, def: ColumnDef): MigrationPlan;
  /**
   * `DROP COLUMN IF EXISTS`.
   * @param table - The table.
   * @param name - The column name.
   */
  dropColumn(table: string, name: string): MigrationPlan;
  /**
   * `RENAME COLUMN`.
   * @param table - The table.
   * @param from - The current name.
   * @param to - The new name.
   */
  renameColumn(table: string, from: string, to: string): MigrationPlan;
  /**
   * `CREATE INDEX IF NOT EXISTS`.
   * @param table - The table.
   * @param columns - The column or columns.
   * @param options - `unique`, `name`, `using`, `where`.
   */
  createIndex(table: string, columns: string | string[], options?: Omit<IndexDef, 'columns'>): MigrationPlan;
  /**
   * `DROP INDEX IF EXISTS`.
   * @param name - The index name.
   */
  dropIndex(name: string): MigrationPlan;
  /**
   * Turns row-level security on.
   * @param table - The table.
   */
  enableRowLevelSecurity(table: string): MigrationPlan;
  /**
   * `CREATE POLICY`.
   * @param table - The table.
   * @param policy - The policy.
   */
  createPolicy(table: string, policy: PolicyDef): MigrationPlan;
}

/**
 * A versioned migration for {@link PlexivoClient.migrate}: applied once, in
 * order, in its own transaction, and recorded in `plexivo_migrations`.
 */
export type Migration = {
  /** A unique, sortable id, such as `'2026_10_17_01_tags'`. */
  id: string;
  /** The change: SQL, a list of SQL, or a function that adds to a {@link MigrationPlan}. */
  up: string | string[] | ((m: MigrationPlan) => unknown);
  /** How to undo it, for {@link PlexivoClient.rollback}. */
  down?: string | string[] | ((m: MigrationPlan) => unknown);
};

/**
 * Inspect and change the schema (GORM's Migrator). Each change method runs at
 * once, in one transaction; use `plan()` to collect several.
 *
 * **Server-only, with the secret key.** The platform refuses raw SQL from a
 * publishable key.
 *
 * @example
 * ```ts
 * const server = createClient(PLEXIVO_DATA_URL, process.env.PLEXIVO_SECRET_KEY!, { persistSession: false });
 * const Post = server.model('posts', {
 *   columns: {
 *     id: 'bigserial primary key',
 *     title: { type: 'text', notNull: true },
 *     created_at: { type: 'timestamptz', notNull: true, default: 'now()' }
 *   },
 *   policies: [{ name: 'read', for: 'select', to: ['anon', 'authenticated'], using: 'true' }]
 * });
 * await server.migrator.autoMigrate(Post);
 * ```
 */
export interface Migrator {
  /**
   * Creates missing tables, columns, indexes, row-level security and
   * policies for these models (like GORM's AutoMigrate). Never drops or
   * changes anything. Row-level security and policies are added only with a
   * new table.
   *
   * @param models - Models (or anything with `table` and `columns`).
   * @returns The SQL it ran.
   * @throws TypeError for a model without `columns`.
   */
  autoMigrate(...models: Array<{ table: string; columns?: Record<string, ColumnDef> }>): Promise<string[]>;
  /**
   * Whether the table exists.
   * @param table - The table, optionally `schema.table`.
   */
  hasTable(table: string): Promise<boolean>;
  /**
   * Whether the column exists.
   * @param table - The table, optionally `schema.table`.
   * @param column - The column.
   */
  hasColumn(table: string, column: string): Promise<boolean>;
  /**
   * Whether the index exists.
   * @param table - The table (not used; index names are unique per schema).
   * @param name - The index name.
   */
  hasIndex(table: string, name: string): Promise<boolean>;
  /**
   * The table's columns, in order.
   * @param table - The table, optionally `schema.table`.
   */
  columns(table: string): Promise<Array<{
    /** The column name. */
    name: string;
    /** Its SQL data type. */
    type: string;
    /** Whether it allows null. */
    nullable: boolean;
    /** Its default, as SQL, or `null`. */
    default: string | null;
  }>>;
  /** The tables in the `public` schema. */
  tables(): Promise<string[]>;
  /**
   * `CREATE TABLE IF NOT EXISTS`, with its indexes, row-level security and policies.
   * @param table - The table name.
   * @param columns - The columns.
   * @param options - Indexes, uniques, checks, policies, a composite primary key.
   */
  createTable(table: string, columns: Record<string, ColumnDef>, options?: ModelOptions): Promise<SqlResult[]>;
  /**
   * `DROP TABLE`.
   * @param table - The table.
   * @param options - `ifExists` (default `true`) and `cascade`.
   */
  dropTable(table: string, options?: { ifExists?: boolean; cascade?: boolean }): Promise<SqlResult[]>;
  /**
   * Renames a table.
   * @param from - The current name.
   * @param to - The new name.
   */
  renameTable(from: string, to: string): Promise<SqlResult[]>;
  /**
   * `ADD COLUMN IF NOT EXISTS`.
   * @param table - The table.
   * @param name - The column name.
   * @param def - The column.
   */
  addColumn(table: string, name: string, def: ColumnDef): Promise<SqlResult[]>;
  /**
   * `DROP COLUMN IF EXISTS`.
   * @param table - The table.
   * @param name - The column name.
   */
  dropColumn(table: string, name: string): Promise<SqlResult[]>;
  /**
   * Renames a column.
   * @param table - The table.
   * @param from - The current name.
   * @param to - The new name.
   */
  renameColumn(table: string, from: string, to: string): Promise<SqlResult[]>;
  /**
   * Changes a column's type.
   * @param table - The table.
   * @param name - The column.
   * @param type - The new SQL type.
   * @param options - `using`: a SQL expression that converts existing values.
   */
  alterColumnType(table: string, name: string, type: string, options?: { using?: string }): Promise<SqlResult[]>;
  /**
   * Sets or drops `NOT NULL`.
   * @param table - The table.
   * @param name - The column.
   * @param notNull - `true` (the default) to set it, `false` to drop it.
   */
  setNotNull(table: string, name: string, notNull?: boolean): Promise<SqlResult[]>;
  /**
   * Sets or drops a column default.
   * @param table - The table.
   * @param name - The column.
   * @param value - The default, as SQL (`"now()"`, `"'draft'"`), or `null` to drop it.
   */
  setDefault(table: string, name: string, value?: string | null): Promise<SqlResult[]>;
  /**
   * `CREATE INDEX IF NOT EXISTS`.
   * @param table - The table.
   * @param columns - The column or columns.
   * @param options - `unique`, `name`, `using`, `where`.
   */
  createIndex(table: string, columns: string | string[], options?: Omit<IndexDef, 'columns'>): Promise<SqlResult[]>;
  /**
   * `DROP INDEX IF EXISTS`.
   * @param name - The index name.
   */
  dropIndex(name: string): Promise<SqlResult[]>;
  /**
   * Adds a constraint.
   * @param table - The table.
   * @param name - The constraint name.
   * @param definition - The SQL after the name, such as `'CHECK (price > 0)'`.
   */
  addConstraint(table: string, name: string, definition: string): Promise<SqlResult[]>;
  /**
   * Drops a constraint, if it exists.
   * @param table - The table.
   * @param name - The constraint name.
   */
  dropConstraint(table: string, name: string): Promise<SqlResult[]>;
  /**
   * Turns row-level security on. The table appears in the Data API once it also has a policy.
   * @param table - The table.
   */
  enableRowLevelSecurity(table: string): Promise<SqlResult[]>;
  /**
   * `CREATE POLICY`.
   * @param table - The table.
   * @param policy - The policy.
   * @throws TypeError for a policy without a name or with an unknown command.
   */
  createPolicy(table: string, policy: PolicyDef): Promise<SqlResult[]>;
  /**
   * Drops a policy, if it exists.
   * @param table - The table.
   * @param name - The policy name.
   */
  dropPolicy(table: string, name: string): Promise<SqlResult[]>;
  /** A {@link MigrationPlan}: changes collected now and run later, together. */
  plan(): MigrationPlan;
}

// ── realtime, storage, GraphQL, functions ──────────────────────────────────

/** A realtime channel's status, as {@link RealtimeChannel.onStatus} reports it. */
export type ChannelStatus = 'SUBSCRIBED' | 'RECONNECTING' | 'CHANNEL_ERROR' | 'CLOSED';

/** A row change from a `changes:<table>` channel. */
export type Change<T = Record<string, unknown>> = {
  /** What happened. */
  type: 'insert' | 'update' | 'delete';
  /** The table. */
  table: string;
  /** The row after the change (insert and update). */
  record?: T;
  /** The row before the change (update and delete), as far as the server sends it. */
  old?: Partial<T>;
};

/**
 * A realtime channel. Add listeners, then `subscribe()` to connect. It
 * stays joined until you `unsubscribe()`: when the connection drops or the
 * server ends the channel (an expired session, a restart), it refreshes the
 * session if needed and joins again, with backoff. A refused join is
 * reported (`onError`, `onStatus`, `ready()`) and not retried.
 *
 * @example
 * ```ts
 * const room = db.channel('room:lobby', { presence: { name: 'Asha' } })
 *   .onBroadcast('cursor', (p) => moveCursor(p))
 *   .onPresence(({ state }) => showWhoIsHere(state))
 *   .subscribe();
 * await room.ready();
 * room.sendBroadcast('cursor', { x: 10, y: 20 });
 * room.unsubscribe();
 * ```
 */
export interface RealtimeChannel<T = Record<string, unknown>> {
  /**
   * Row changes on a `changes:<table>` channel.
   * @param listener - Gets each {@link Change}.
   */
  onChange(listener: (change: Change<T>) => void): RealtimeChannel<T>;
  /**
   * Broadcast messages with this event name, or `'*'` for all.
   * @param event - The event name, or `'*'`.
   * @param listener - Gets the payload, and the event name for `'*'`.
   */
  onBroadcast(event: string, listener: (payload: Record<string, unknown>, event?: string) => void): RealtimeChannel<T>;
  /**
   * Who is in the room: the full state on join, then each change.
   * @param listener - Gets `presence_state` or `presence_diff` with the state.
   */
  onPresence(listener: (update: {
    /** `'presence_state'` for the full state, `'presence_diff'` for a change. */
    event: 'presence_state' | 'presence_diff';
    /** The presence state, as the server sends it. */
    state: Record<string, unknown>;
  }) => void): RealtimeChannel<T>;
  /**
   * The channel was refused or the session expired. `error.code` says why,
   * such as `token_expired`.
   * @param listener - Gets the error.
   */
  onError(listener: (error: Error & { code?: string }) => void): RealtimeChannel<T>;
  /**
   * The channel's status: `'SUBSCRIBED'` on every join (and rejoin),
   * `'RECONNECTING'` when the connection dropped or the server ended the
   * channel (it joins again by itself), `'CHANNEL_ERROR'` when a join was
   * refused (not retried) and `'CLOSED'` after `unsubscribe()`.
   * @param listener - Gets the status, and the error for `'CHANNEL_ERROR'`.
   */
  onStatus(listener: (status: ChannelStatus, error?: PlexivoError) => void): RealtimeChannel<T>;
  /** Where the channel is now: `'connecting'`, `'joined'`, `'reconnecting'`, `'refused'` or `'closed'`. */
  readonly state: 'connecting' | 'joined' | 'reconnecting' | 'refused' | 'closed';
  /** `true` while joined. */
  readonly joined: boolean;
  /**
   * One listener for any event: `'change'`, `'presence'`, `'error'`, or a broadcast event name.
   * @param event - The event.
   * @param listener - The listener.
   */
  on(event: string, listener: (...args: any[]) => void): RealtimeChannel<T>;
  /**
   * Sends a broadcast message to everyone in the room.
   * @param event - The event name.
   * @param payload - The message.
   * @throws Error when the channel is not connected yet; wait for `ready()`.
   */
  sendBroadcast(event: string, payload?: Record<string, unknown>): RealtimeChannel<T>;
  /**
   * Resolves once the channel has joined.
   * @throws PlexivoError (rejects) when the server refuses the join, with `code` such as `table_not_exposed` or `sign_in_required`.
   */
  ready(): Promise<void>;
  /**
   * Connects and joins. Calling it again does nothing (beyond adding `callback`).
   * @param callback - Gets each status, as {@link RealtimeChannel.onStatus} does.
   */
  subscribe(callback?: (status: ChannelStatus, error?: PlexivoError) => void): RealtimeChannel<T>;
  /** Leaves, disconnects and removes the listeners. */
  unsubscribe(): void;
}

/** A stored file. */
export type StorageObject = {
  /** The file's id, for `download`, `createSignedDownloadUrl` and `remove`. */
  id: string;
  /** The path it was uploaded to, such as `'avatars/me.png'`. */
  path: string;
  /** Its content type. */
  content_type: string;
  /** Its size in bytes, as declared at upload. */
  expected_size: number;
  /** `'ready'` once the upload is complete. */
  status: 'ready' | 'pending' | 'uploading';
  /** When it was created (ISO 8601). */
  inserted_at?: string;
  /** When the upload finished (ISO 8601), or `null`. */
  uploaded_at?: string | null;
};

/**
 * File storage for the signed-in user. Files go straight to storage with a
 * short-lived signed URL; the app never holds a storage credential. Every
 * method needs a signed-in user and throws an `Error` without one.
 *
 * @example
 * ```ts
 * const object = await db.storage.upload('avatars/me.png', file, { contentType: 'image/png' });
 * const { data, contentType } = await db.storage.download(object.id);
 * const { signed_url } = await db.storage.createSignedDownloadUrl(object.id);
 * ```
 */
export interface ObjectStorageClient {
  /** The signed-in user's files. */
  list(): Promise<StorageObject[]>;
  /**
   * Uploads a file.
   * @param path - Where to store it, such as `'avatars/me.png'`.
   * @param body - The content.
   * @param options - `contentType`, required.
   * @returns The stored file.
   * @throws TypeError without `contentType`, or for a body of another kind.
   * @throws {@link PlexivoError} when the server refuses.
   */
  upload(path: string, body: string | Blob | ArrayBuffer | ArrayBufferView, options: { contentType: string }): Promise<StorageObject>;
  /**
   * A short-lived URL anyone can download the file from.
   * @param id - The file's id.
   */
  createSignedDownloadUrl(id: string): Promise<{
    /** The file. */
    object: StorageObject;
    /** The download URL. */
    signed_url: string;
    /** When the URL stops working (ISO 8601). */
    expires_at: string;
  }>;
  /**
   * Downloads a file.
   * @param id - The file's id.
   * @throws {@link PlexivoError} when the download fails.
   */
  download(id: string): Promise<{
    /** The content. */
    data: Uint8Array;
    /** Its content type, when known. */
    contentType: string | null;
  }>;
  /**
   * Deletes a file.
   * @param id - The file's id.
   * @returns `null` once deleted.
   */
  remove(id: string): Promise<null>;
}

/** A GraphQL answer. Errors are data, the way GraphQL returns them. */
export type GraphQLResult<T = any> = {
  /** The data, when the query ran. */
  data?: T;
  /** What went wrong, if anything. */
  errors?: Array<{
    /** The error message. */
    message: string;
    /** Where in the answer it happened. */
    path?: Array<string | number>;
    /** More detail, such as a `code`. */
    extensions?: Record<string, unknown>;
  }>;
};

/**
 * GraphQL on your schema. Call it for a query or mutation; use `subscribe`
 * for a live query.
 *
 * A GraphQL error comes back in `errors`; a refused request (for example a
 * bad key) rejects with a {@link PlexivoError}.
 *
 * @example
 * ```ts
 * const { data, errors } = await db.graphql(
 *   'query($b: String!) { notes(where: {body: {eq: $b}}) { body } }',
 *   { b: 'hi' }
 * );
 * await db.graphql('{ notesAggregate { count } }', {}, { persisted: true });
 * ```
 */
export interface GraphQLClient {
  /**
   * Runs a query or mutation.
   * @param query - The GraphQL document.
   * @param variables - Its variables.
   * @param options - The operation name, or `{ operationName, persisted }`. `persisted: true` sends only the query's hash after the first time (automatic persisted queries).
   */
  <T = any>(query: string, variables?: Record<string, unknown>, options?: string | { operationName?: string; persisted?: boolean }): Promise<GraphQLResult<T>>;
  /**
   * A live query: `onResult` gets the answer now, and again whenever a row it reads changes.
   *
   * @param query - The GraphQL document.
   * @param variables - Its variables.
   * @param onResult - Gets each answer; a refused subscription arrives as `errors`.
   * @returns A handle to stop it.
   *
   * @example
   * ```ts
   * const live = db.graphql.subscribe('subscription { notes { body } }', {}, ({ data }) => render(data));
   * // Later:
   * live.unsubscribe();
   * ```
   */
  subscribe<T = any>(query: string, variables: Record<string, unknown>, onResult: (result: GraphQLResult<T>) => void): {
    /** Stops the live query and closes its channel. */
    unsubscribe(): void;
  };
}

/** The live Data API, from {@link PlexivoClient.getApi}: what is exposed, and what is not. */
export type LiveApi = {
  /** How the Data API is exposing the schema. */
  mode: string;
  /** Every exposed table and view. */
  tables: Array<{
    /** The table name. */
    name: string;
    /** A table or a view. */
    kind: 'table' | 'view';
    /** Whether rows can be written. */
    writable: boolean;
    /** The primary key columns. */
    primary_key: string[];
    /** The table's SQL comment, or `null`. */
    comment: string | null;
    /** Foreign keys from this table. */
    foreign_keys: Array<{
      /** The constraint name. */
      name: string;
      /** The columns here. */
      columns: string[];
      /** The referenced table. */
      ref_table: string;
      /** The referenced columns. */
      ref_columns: string[];
    }>;
    /** The columns. */
    columns: Array<{
      /** The column name. */
      name: string;
      /** The SQL type. */
      type: string;
      /** A friendlier type name, when there is one. */
      display_type?: string;
      /** Whether it is `NOT NULL`. */
      not_null: boolean;
      /** Whether it has a default. */
      has_default: boolean;
      /** Whether it cannot be written (generated or identity). */
      read_only: boolean;
      /** The column's SQL comment, or `null`. */
      comment: string | null;
    }>;
  }>;
  /** Every exposed database function, for {@link PlexivoClient.rpc}. */
  functions: Array<{
    /** The function name. */
    name: string;
    /** Its arguments. */
    args: Array<{
      /** The argument name. */
      name: string;
      /** Its SQL type. */
      type: string;
    }>;
    /** The arguments without a default. */
    required: string[];
    /** The SQL return type. */
    returns: string;
    /** Whether it returns a set of rows. */
    returns_set: boolean;
    /** The function's SQL comment, or `null`. */
    comment: string | null;
  }>;
  /** Tables and functions that are not exposed, and why. */
  hidden?: Array<{
    /** The name. */
    name: string;
    /** What it is. */
    kind: string;
    /** Why it is hidden, such as no row-level security policy. */
    reason: string;
  }>;
};

// ── the client ─────────────────────────────────────────────────────────────

/**
 * The shape of generated database types: tables with their `Row`, `Insert`
 * and `Update` types, and functions with their `Args` and `Returns`.
 * Generate yours with `renderApiTypes` from `@plexivo/client/generate-types`.
 */
export type DatabaseDefinition = {
  /** The `public` schema. */
  public: {
    /** Tables by name. */
    Tables: Record<string, {
      /** A row as read. */
      Row: any;
      /** A row to insert. */
      Insert: any;
      /** Columns to update. */
      Update: any;
    }>;
    /** Exposed functions by name. */
    Functions?: Record<string, {
      /** The arguments. */
      Args: any;
      /** The return type. */
      Returns: any;
    }>;
  };
};

/** The database type when you do not pass one: any table, any columns. */
export type DefaultDatabase = {
  /** The `public` schema. */
  public: {
    /** Any table. */
    Tables: Record<string, {
      /** A row as read. */
      Row: Record<string, any>;
      /** A row to insert. */
      Insert: Record<string, any>;
      /** Columns to update. */
      Update: Record<string, any>;
    }>;
    /** Any function. */
    Functions: Record<string, {
      /** The arguments. */
      Args: Record<string, unknown>;
      /** The return type. */
      Returns: unknown;
    }>;
  };
};
/** A table name in the database type. */
type TableName<D extends DatabaseDefinition> = keyof D['public']['Tables'] & string;
/** A table's `Row` type. */
type RowOf<D extends DatabaseDefinition, T extends TableName<D>> = D['public']['Tables'][T]['Row'];
/** A table's `Insert` type. */
type InsertOf<D extends DatabaseDefinition, T extends TableName<D>> = D['public']['Tables'][T]['Insert'];
/** A table's `Update` type. */
type UpdateOf<D extends DatabaseDefinition, T extends TableName<D>> = D['public']['Tables'][T]['Update'];
/** The database type's functions, or any function when it has none. */
/** What an `rpc()` call resolves to. */
export type RpcResult<T> = {
  /** What the function returned: its rows, or its value. */
  data: T;
  /** The total number of rows with `{ count: 'exact' }`; otherwise `null`. */
  count: number | null;
  /** Always `null`. Failures reject with a {@link PlexivoError} (or resolve as a {@link Failure} with `throwOnError: false`). */
  error: null;
};

/**
 * A database function call, from {@link PlexivoClient.rpc}. Await it as it
 * is for what the function returns. For a function that returns rows
 * (`RETURNS SETOF <table>` or `RETURNS TABLE (…)`), chain a query on its
 * result first: columns (and, for `SETOF` an exposed table, embeds through
 * that table's foreign keys), filters, order, limit, range, `single()` or
 * `maybeSingle()`, and a count with `rpc(fn, args, { count: 'exact' })`.
 *
 * @example
 * ```ts
 * const { data, count } = await db.rpc('search_posts', { q: 'postgres' }, { count: 'exact' })
 *   .select('id, title, author:profiles(username)')
 *   .gte('likes', 10)
 *   .order('created_at', { ascending: false })
 *   .range(0, 9);
 * ```
 */
export interface RpcBuilder<T = unknown, Throws extends boolean = true> extends Conditions<T extends Array<infer R> ? (R extends Record<string, unknown> ? R : Record<string, unknown>) : Record<string, unknown>>, PromiseLike<Outcome<RpcResult<T>, Throws>> {
  /** The function name. */
  readonly fn: string;
  /**
   * The columns of the returned rows, and related rows in Supabase's syntax.
   * @param columns - Column names, `'a, b'`, `'author:profiles(username)'`; `{ count: 'exact' }` last for the total.
   */
  select(...columns: Array<string | string[] | Record<string, string> | { count?: 'exact'; head?: boolean }>): this;
  /** Sorts the returned rows. See {@link OrderMethod}. */
  order: OrderMethod<this>;
  /** Same as `order`. */
  orderBy: OrderMethod<this>;
  /**
   * At most `n` rows.
   * @param n - The maximum.
   * @param options - `referencedTable`: limit an embed's rows instead.
   */
  limit(n: number, options?: EmbedTarget): this;
  /**
   * Skips the first `n` rows.
   * @param n - How many to skip.
   * @param options - `referencedTable`: for an embed's rows instead.
   */
  offset(n: number, options?: EmbedTarget): this;
  /**
   * Rows `from` to `to`, inclusive and zero-based.
   * @param from - The first row.
   * @param to - The last row.
   * @param options - `referencedTable`: for an embed's rows instead.
   */
  range(from: number, to: number, options?: EmbedTarget): this;
  /**
   * Related rows of the returned rows (a `SETOF` exposed table only).
   * @param relation - A related table name, or a dotted path.
   * @param callback - Shapes the related rows.
   */
  preload(relation: string, callback?: Related): this;
  /**
   * Like `preload`, keeping only rows with a matching related row.
   * @param relation - A related table name.
   * @param callback - Shapes and filters the related rows.
   */
  joins(relation: string, callback?: Related): this;
  /** Exactly one row as `data`; rejects with {@link RecordNotFoundError} for none and `multiple_rows` for several. */
  single(): PromiseLike<Outcome<RpcResult<T extends Array<infer R> ? R : T>, Throws>>;
  /** One row or `data: null`; rejects with `multiple_rows` for several. */
  maybeSingle(): PromiseLike<Outcome<RpcResult<(T extends Array<infer R> ? R : T) | null>, Throws>>;
  /**
   * Cancels the request when `signal` aborts.
   * @param signal - An `AbortController`'s signal.
   */
  abortSignal(signal: AbortSignal): this;
  /** The structured call this builder sends (`{ op: 'rpc', … }`), without running it. */
  toQuery(): Record<string, unknown>;
  /**
   * Runs the call and handles a failure.
   * @param onrejected - Called with the error.
   */
  catch<R = never>(onrejected?: (reason: any) => R | PromiseLike<R>): Promise<Outcome<RpcResult<T>, Throws> | R>;
  /**
   * Runs the call and calls `onfinally` when it settles.
   * @param onfinally - Called on success or failure.
   */
  finally(onfinally?: () => void): Promise<Outcome<RpcResult<T>, Throws>>;
}

/** The functions of a database type, or any function when it has none. */
type Functions<D extends DatabaseDefinition> = D['public'] extends {
  /** The functions. */
  Functions: infer F;
} ? F : Record<string, {
  /** The arguments. */
  Args: Record<string, unknown>;
  /** The return type. */
  Returns: unknown;
}>;

/**
 * A client for one Plexivo Postgres project. Make one with {@link createClient}.
 *
 * With the publishable key it is safe in a browser or app: every request runs
 * as the signed-in user (or as `anon`) under row-level security. With the
 * secret key, on a server only, it can also run raw SQL, migrations and user
 * imports.
 */
export interface PlexivoClient<TDatabase extends DatabaseDefinition = DefaultDatabase, Throws extends boolean = true> {
  /** The project URL the client talks to, without a trailing slash. */
  readonly apiUrl: string;
  /** The trace id of the last response, to quote to support. */
  readonly lastTraceId: string | null;
  /** Sign-up, sign-in, sessions, two-factor authentication and organisations. */
  auth: AuthClient;
  /** Organisations for your app's users. Same as `auth.orgs`. */
  orgs: OrgsClient;
  /**
   * A query on one table. Chain filters, then await it or call a terminal
   * method. Uses the table's model when one is defined.
   *
   * @param table - The table name (typed when you pass your database type to {@link createClient}).
   * @throws TypeError when `table` is not a non-empty string.
   *
   * @example
   * ```ts
   * const posts = await db.from('posts')
   *   .select('id', 'title')
   *   .where('likes', '>', 10)
   *   .whereHas('comments', (c) => c.where('approved', true))
   *   .preload('author', (a) => a.select('name'))
   *   .order('created_at', 'desc')
   *   .limit(20);
   *
   * const { data, count } = await db.from('notes').select('id, body', { count: 'exact' }).eq('pinned', true);
   * ```
   */
  from<TName extends TableName<TDatabase>>(table: TName): QueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>, Throws>;
  /**
   * Same as {@link PlexivoClient.from}.
   * @param table - The table name.
   */
  table<TName extends TableName<TDatabase>>(table: TName): QueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>, Throws>;
  /**
   * Defines a model: what GORM learns from a struct, said once. Relations,
   * hooks, scopes, soft deletes, and columns for migrations. From then on,
   * `db.from(table)` uses it too.
   *
   * @param table - The table name.
   * @param options - The model's {@link ModelOptions}.
   * @returns The model, with every query method as a shortcut.
   * @throws TypeError for an unknown hook name.
   *
   * @example
   * ```ts
   * import { belongsTo, hasMany, manyToMany } from '@plexivo/client';
   *
   * const Post = db.model('posts', {
   *   softDelete: 'deleted_at',
   *   relations: {
   *     author: belongsTo('authors', { foreignKey: 'author_id' }),
   *     comments: hasMany('comments', { foreignKey: 'post_id' }),
   *     tags: manyToMany('tags', { through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id' })
   *   },
   *   hooks: { beforeCreate: (row) => ({ ...row, slug: slugify(row.title) }) },
   *   scopes: { published: (q) => q.where('published', true) }
   * });
   *
   * await Post.query().scopes('published').preload('author').preload('tags').find();
   * const post = await Post.first(1);
   * await Post.association(post, 'tags').append([elixir, postgres]);
   * ```
   */
  model<TName extends TableName<TDatabase>>(table: TName, options?: ModelOptions<RowOf<TDatabase, TName>>): Model<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  /**
   * Operations that commit together or not at all, sent as one request.
   * Record them on `tx` **without awaiting**; pass one result to the next
   * with `handle.ref('id')`. A row lock (`lockForUpdate()`) holds until
   * commit.
   *
   * If any operation fails, everything is rolled back and the error's
   * `operation` names the step. For logic that must read and then decide in
   * the database, use a database function with {@link PlexivoClient.rpc}.
   *
   * @param callback - Records the operations on `tx`.
   * @returns Each operation's result, in order. An empty array when nothing was recorded.
   * @throws {@link PlexivoError} when an operation fails (with `operation` set), or coded `transaction_already_sent` when an operation is recorded after the transaction was sent (for example after an `await` in the callback).
   *
   * @example
   * ```ts
   * const [author, post] = await db.transaction((tx) => {
   *   const author = tx.from('authors').create({ name: 'Asha' }) as TxHandle<Author>;
   *   tx.from('posts').create({ title: 'Hello', author_id: author.ref('id') });
   *   tx.from('products').where('sku', 'B2').lockForUpdate().find();  // row lock until commit
   *   tx.from('products').where('sku', 'B2').decrement('stock');
   * });
   * ```
   */
  transaction(callback: (tx: TransactionClient<TDatabase>) => unknown): Promise<any[]>;
  /**
   * Calls a database function exposed with `COMMENT ON FUNCTION … IS '@expose'`.
   * Await it as it is, or, for a function that returns rows, chain a query
   * on its result first (see {@link RpcBuilder}).
   *
   * @param fn - The function name.
   * @param args - Its arguments, by name.
   * @param options - `count: 'exact'` for the total number of rows; `head: true` for the count alone.
   * @returns A builder resolving to `{ data, count, error: null }`.
   * @throws {@link PlexivoError} (rejects) when the call fails: `function_not_exposed`, a database error, …
   *
   * @example
   * ```ts
   * const { data: total } = await db.rpc('note_count', { owner: userId });
   * const { data: hits } = await db.rpc('search_posts', { q: 'postgres' }).select('id, title').order('id').limit(10);
   * ```
   */
  rpc<TName extends keyof Functions<TDatabase> & string>(fn: TName, args?: Record<string, unknown>, options?: { count?: 'exact'; head?: boolean }): RpcBuilder<Functions<TDatabase>[TName] extends {
    /** The function's return type. */
    Returns: infer R;
  } ? R : unknown, Throws>;
  /** GraphQL queries, mutations and live queries on your schema. See {@link GraphQLClient}. */
  graphql: GraphQLClient;
  /** Plexivo Functions: your server-side code beside the data. */
  functions: {
    /**
     * Calls a Plexivo Function with the signed-in user's token. An object
     * body is sent as JSON; a string, `Blob`, `ArrayBuffer` or typed array is
     * sent as it is.
     *
     * @param name - The function name.
     * @param options - `body`; `method` (`'POST'` when left out); `headers`; `path`, a sub-route such as `'status/detail'`; and `query`, the query string (`null` and `undefined` values are left out).
     * @returns The response: JSON parsed, otherwise text.
     * @throws TypeError for a name or path with `.` or `..` segments.
     * @throws {@link PlexivoError} when the function responds with an error status.
     *
     * @example
     * ```ts
     * const { data } = await db.functions.invoke('send-receipt', { body: { orderId } });
     * await db.functions.invoke('echo', { method: 'GET', path: 'status/detail', query: { page: 2 } });
     * ```
     */
    invoke<T = any>(name: string, options?: { body?: unknown; method?: string; headers?: Record<string, string>; path?: string; query?: Record<string, string | number | boolean | null | undefined> }): Promise<{
      /** The response body: parsed JSON, or text. */
      data: T;
      /** The HTTP status. */
      status: number;
      /** The response headers. */
      headers: Headers;
    }>;
  };
  /**
   * A realtime channel. Works signed out too, where the rows or room allow it.
   *
   * - `'changes:<table>'`: row changes you may read, with an optional `filter` such as `'status=eq.open'`.
   * - `'room:<name>'`: broadcast and presence for everyone who joins (`'room:private:…'` for signed-in users only).
   * - `'<table>'`: the original per-user starter channel (`'items'` when left out).
   *
   * @param topic - The topic.
   * @param options - `filter` for row changes; `presence`, what others see about you in a room.
   * @returns The channel. Call `subscribe()` to connect.
   *
   * @example
   * ```ts
   * const orders = db.channel('changes:orders', { filter: 'status=eq.open' })
   *   .onChange(({ type, record, old }) => update(type, record, old))
   *   .subscribe();
   * // Later:
   * orders.unsubscribe();
   * ```
   */
  channel<T = Record<string, unknown>>(topic?: string, options?: { filter?: string; presence?: Record<string, unknown> }): RealtimeChannel<T>;
  /** File storage. See {@link ObjectStorageClient}. */
  storage: ObjectStorageClient;
  /** The live Data API: every exposed table (columns, keys, relations) and function. Feed it to `renderApiTypes` for types. */
  getApi(): Promise<LiveApi>;
  /** The versioned starter schema contract. Feed it to `renderTypes` for types. */
  getSchema(): Promise<{
    /** The contract version. */
    version: string;
    /** Always `'public'`. */
    schema: 'public';
    /** The tables, by name. */
    tables: Record<string, unknown>;
  }>;
  /**
   * Rows from one SQL query, as a tagged template. Values become `$1`, `$2` …
   * parameters, never text in the query. A `Date` is sent as ISO 8601 text.
   *
   * **Server-only, with the secret key.** The secret key bypasses row-level
   * security; never ship it in a browser or mobile app. The platform refuses
   * raw SQL from a publishable key.
   *
   * @param strings - The template's text.
   * @param values - The template's values.
   * @throws TypeError when not used as a tagged template.
   * @throws {@link PlexivoError} when the statement fails.
   *
   * @example
   * ```ts
   * const server = createClient(PLEXIVO_DATA_URL, process.env.PLEXIVO_SECRET_KEY!, { persistSession: false });
   * const big = await server.sql`select * from orders where total > ${100} and status = ${'paid'}`;
   * ```
   */
  sql<T = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  /**
   * Rows from one SQL query with `$1`, `$2` … parameters.
   * **Server-only, with the secret key.**
   *
   * @param sql - The SQL.
   * @param params - The parameters.
   * @throws {@link PlexivoError} when the statement fails.
   */
  raw<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs one SQL statement.
   * **Server-only, with the secret key.**
   *
   * @param sql - The SQL, with `$1`, `$2` … parameters.
   * @param params - The parameters.
   * @returns The command and how many rows it touched.
   * @throws {@link PlexivoError} when the statement fails.
   */
  exec(sql: string, params?: unknown[]): Promise<{
    /** The SQL command, such as `'UPDATE'`. */
    command: string | null;
    /** How many rows it returned or changed. */
    rowCount: number;
  }>;
  /**
   * Several statements in one transaction: all commit, or none do.
   * **Server-only, with the secret key.**
   *
   * @param statements - SQL text, or `{ sql, params }`.
   * @returns Each statement's result.
   * @throws {@link PlexivoError} when a statement fails; nothing is committed.
   */
  sqlTransaction(statements: Array<string | { sql: string; params?: unknown[] }>): Promise<SqlResult[]>;
  /** Inspect and change the schema. **Server-only, with the secret key.** See {@link Migrator}. */
  migrator: Migrator;
  /**
   * Applies versioned migrations that have not run yet: each once, in order,
   * in its own transaction, recorded in `plexivo_migrations`.
   * **Server-only, with the secret key.**
   *
   * @param migrations - Every migration, oldest first.
   * @param options - `table`: where applied ids are recorded.
   * @returns The ids applied this time.
   * @throws TypeError for a migration without an id.
   * @throws {@link PlexivoError} when a migration fails; it is rolled back, and the ones before it stay applied.
   *
   * @example
   * ```ts
   * const migrations = [
   *   { id: '2026_10_17_01_tags', up: 'create table tags (id bigserial primary key, name text unique)', down: 'drop table tags' },
   *   { id: '2026_10_17_02_slug',
   *     up: (m) => m.addColumn('posts', 'slug', 'text').createIndex('posts', 'slug', { unique: true }),
   *     down: (m) => m.dropColumn('posts', 'slug') }
   * ];
   * await server.migrate(migrations);
   * await server.rollback(migrations, { steps: 1 });
   * ```
   */
  migrate(migrations: Migration[], options?: { table?: string }): Promise<string[]>;
  /**
   * Undoes the last applied migrations, newest first, with their `down`.
   * **Server-only, with the secret key.**
   *
   * @param migrations - Every migration.
   * @param options - `steps`: how many to undo (1 when left out); `table`: where applied ids are recorded.
   * @returns The ids undone.
   * @throws Error when a migration to undo has no `down`.
   */
  rollback(migrations: Migration[], options?: { steps?: number; table?: string }): Promise<string[]>;
}

/** Options for {@link createClient}. */
export type ClientOptions = {
  /** A Fetch API implementation (the global one when left out); also how to add headers to every request. */
  fetch?: typeof fetch;
  /** A WebSocket implementation for realtime, where there is no global one. */
  WebSocket?: typeof WebSocket;
  /** A session to start with. */
  initialSession?: Session;
  /** `false` keeps the session in memory only (use it on a server). */
  persistSession?: boolean;
  /** The storage key for the session. */
  storageKey?: string;
  /** Where the session is kept: `localStorage` in a browser; an encrypted store in React Native. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** An id sent when joining realtime channels. */
  realtimeClientId?: string;
  /** How often realtime checks the connection is alive, in milliseconds (25,000 when left out). */
  realtimeHeartbeatMs?: number;
  /**
   * `false`: an awaited query or `rpc()` that fails resolves as
   * `{ data: null, count: null, error }` (a {@link Failure}) instead of
   * rejecting, as Supabase does. Terminal methods such as `first()`,
   * `find()` and `create()` still reject. `true` (the default) rejects.
   */
  throwOnError?: boolean;
};

/**
 * Creates a client for one Plexivo Postgres project.
 *
 * Use the **publishable key** in a browser or app: it is safe there, and
 * row-level security decides what each request can do. Use the **secret
 * key** only on a server: it bypasses row-level security and can run raw SQL,
 * migrations and user imports. Both are on the database's **Connect** tab.
 *
 * In a browser, the session persists in `localStorage`. In React Native, pass
 * an encrypted `storage` adapter. On a server, pass `persistSession: false`.
 *
 * @typeParam TDatabase - Your generated database type, for typed tables, columns and functions.
 * @param apiUrl - The project's data URL.
 * @param key - The publishable key, or the secret key on a server.
 * @param options - See {@link ClientOptions}: `fetch`, `WebSocket`, `initialSession`, `persistSession`, `storageKey`, `storage`, `realtimeClientId`, `realtimeHeartbeatMs` and `throwOnError`.
 * @throws Error without `apiUrl` or `key`, or when there is no Fetch API.
 * @throws {@link PlexivoError} coded `secret_key_in_browser` for the secret key in a browser or web worker.
 *
 * @example In an app
 * ```ts
 * import { createClient } from '@plexivo/client';
 * import type { Database } from './database';
 *
 * export const db = createClient<Database>(
 *   import.meta.env.VITE_PLEXIVO_DATA_URL,
 *   import.meta.env.VITE_PLEXIVO_PUBLISHABLE_KEY
 * );
 * ```
 *
 * @example On a server
 * ```ts
 * const server = createClient(process.env.PLEXIVO_DATA_URL!, process.env.PLEXIVO_SECRET_KEY!, {
 *   persistSession: false
 * });
 * ```
 */
export function createClient<TDatabase extends DatabaseDefinition = DefaultDatabase>(apiUrl: string, key: string, options: ClientOptions & { throwOnError: false }): PlexivoClient<TDatabase, false>;
export function createClient<TDatabase extends DatabaseDefinition = DefaultDatabase>(apiUrl: string, key: string, options?: ClientOptions): PlexivoClient<TDatabase>;

/** The version of this package, such as `'0.4.0'`. */
export const VERSION: string;

/**
 * The {@link RpcBuilder} class, for `instanceof` checks.
 */
export const RpcBuilder: {
  /** The prototype every function-call builder shares. */
  prototype: RpcBuilder<unknown, boolean>;
};
