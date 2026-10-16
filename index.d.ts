// @plexivo/client — types for the Plexivo Postgres client: data (Supabase-
// style and GORM-style on one builder), models, transactions, raw SQL and
// migrations (server, secret key), auth, storage, realtime, GraphQL, functions.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ── auth ───────────────────────────────────────────────────────────────────

export type Credentials = { email: string; password: string; mfa_code?: string };
export type AppUser = {
  id: string;
  email: string | null;
  is_anonymous?: boolean;
  created_at?: string;
  mfa?: { factor_type: 'totp' | null; status: 'unenrolled' | 'pending' | 'enabled'; verified_at: string | null };
};
export type Session = {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  assurance_level: 'aal1' | 'aal2';
  user: AppUser;
};
export type DeviceSession = { id: string; current: boolean; user_agent?: string | null; ip?: string | null; created_at: string; last_used_at?: string | null };
export type Organisation = { id: string; name: string; slug?: string; role: 'owner' | 'admin' | 'member'; metadata?: Json };
export type Member = { user_id: string; email: string | null; role: 'owner' | 'admin' | 'member' };
export type Invitation = { id: string; email: string; role: string; token?: string; expires_at?: string };
export type OAuthProvider = 'google' | 'github' | 'microsoft' | (string & {});

export interface OrgsClient {
  list(): Promise<Organisation[]>;
  create(input: { name: string; slug?: string; metadata?: Json }): Promise<Organisation>;
  delete(orgId: string): Promise<null>;
  members(orgId: string): Promise<Member[]>;
  setRole(orgId: string, userId: string, role: string): Promise<Member>;
  removeMember(orgId: string, userId: string): Promise<null>;
  invitations(orgId: string): Promise<Invitation[]>;
  invite(orgId: string, input: { email: string; role?: string }): Promise<Invitation>;
  revokeInvitation(orgId: string, invitationId: string): Promise<null>;
  accept(token: string): Promise<Organisation>;
  acceptInvitation(token: string): Promise<Organisation>;
}

export interface AuthClient {
  signUp(credentials: Credentials): Promise<Session>;
  signInWithPassword(credentials: Credentials): Promise<Session>;
  signInAnonymously(): Promise<Session>;
  /** The guest becomes an account, keeping its id and rows. */
  linkEmail(input: { email: string; password: string }): Promise<Session>;
  signInWithOAuth(input: { provider: OAuthProvider; redirectTo?: string; skipBrowserRedirect?: boolean }): Promise<{ url: string; codeVerifier: string }>;
  exchangeCodeForSession(code: string, codeVerifier?: string): Promise<Session>;
  getProviders(): Promise<{
    providers: Array<{ id: string; type: 'oauth' | 'oidc'; name: string }>;
    password: { enabled: boolean };
    passwordless_email: { enabled: boolean; delivery: 'otp' };
  }>;
  resetPasswordForEmail(email: string): Promise<{ accepted: true }>;
  verifyPasswordRecovery(input: { email: string; code: string; newPassword: string }): Promise<void>;
  signInWithOtp(input: { email: string }): Promise<{ accepted: true }>;
  verifyOtp(input: { email: string; token: string; mfaCode?: string }): Promise<Session>;
  refreshSession(refreshToken?: string): Promise<Session>;
  getSession(): Session | null;
  getUser(): Promise<AppUser>;
  updatePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
  deleteUser(input: { password: string }): Promise<void>;
  signOut(options?: { scope?: 'local' | 'global' }): Promise<void>;
  listSessions(): Promise<DeviceSession[]>;
  getSessions(): Promise<DeviceSession[]>;
  revokeSession(sessionId: string): Promise<null>;
  onAuthStateChange(listener: (event: string, session: Session | null) => void): { data: { subscription: { unsubscribe(): void } } };
  orgs: OrgsClient;
  mfa: {
    enroll(): Promise<{ factor_type: 'totp'; secret: string; uri: string; status: 'pending' }>;
    verify(input: { code: string }): Promise<{ factor_type: 'totp'; status: 'enabled' }>;
    unenroll(input: { password: string }): Promise<void>;
  };
  /** Server-only, with the secret key. */
  admin: {
    importFromSupabase(): Promise<Record<string, number>>;
    importUsers(users: Array<{ id?: string; email: string; password_hash?: string; email_confirmed_at?: string | null; metadata?: Json }>): Promise<Record<string, number>>;
  };
}

// ── results and errors ─────────────────────────────────────────────────────

/** Rows that read both ways: an array, and `{data, count, error}`. */
export type Result<T> = T[] & { readonly data: T[]; readonly count: number | null; readonly error: null };
export type SingleResult<T> = { data: T | null; count: number | null; error: null };

export class PlexivoError extends Error {
  status: number;
  code?: string;
  hint?: string;
  sqlstate?: string;
  traceId: string | null;
  details?: unknown;
  /** In a transaction, which operation failed (0-based). */
  operation?: number;
}
export class RecordNotFoundError extends PlexivoError {
  table: string;
}
export function isNotFound(error: unknown): boolean;
export function isUniqueViolation(error: unknown): boolean;
export function isPermissionDenied(error: unknown): boolean;

// ── queries ────────────────────────────────────────────────────────────────

export type Operator =
  | '=' | '==' | '!=' | '<>' | '>' | '>=' | '<' | '<='
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'not like' | 'not ilike' | 'match' | 'imatch' | '~' | '~*'
  | 'in' | 'not in' | 'is' | 'is not'
  | 'contains' | '@>' | 'contained by' | '<@' | 'overlaps' | '&&'
  | 'fts' | 'plfts' | 'phfts' | 'wfts' | 'search' | `${'fts' | 'plfts' | 'phfts' | 'wfts'}(${string})`;

export type FilterNode =
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode }
  | { column: string; op: string; value: Json }
  | { column: string; path: string[]; op: string; value: Json }
  | { has: string; hint?: string; where?: FilterNode };

type Cols<Row> = Extract<keyof Row, string>;
type Grouper = (q: Conditions<any>) => Conditions<any> | void;
type Related = (q: EmbedBuilder) => EmbedBuilder | void;

/** Filters, alone (for groups) or as part of a query. */
export interface Conditions<Row = Record<string, unknown>> {
  where(conditions: Partial<Row> | Record<string, unknown>): this;
  where(column: Cols<Row> | (string & {}), value: unknown): this;
  where(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  where(group: Grouper): this;
  orWhere(conditions: Partial<Row> | Record<string, unknown>): this;
  orWhere(column: Cols<Row> | (string & {}), value: unknown): this;
  orWhere(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  orWhere(group: Grouper): this;
  whereNot(conditions: Partial<Row> | Record<string, unknown>): this;
  whereNot(column: Cols<Row> | (string & {}), value: unknown): this;
  whereNot(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  whereNot(group: Grouper): this;
  orWhereNot(column: Cols<Row> | (string & {}), op: Operator, value: unknown): this;
  whereIn(column: Cols<Row> | (string & {}), values: unknown[]): this;
  whereNotIn(column: Cols<Row> | (string & {}), values: unknown[]): this;
  whereNull(column: Cols<Row> | (string & {})): this;
  whereNotNull(column: Cols<Row> | (string & {})): this;
  whereBetween(column: Cols<Row> | (string & {}), low: unknown, high: unknown): this;
  whereNotBetween(column: Cols<Row> | (string & {}), low: unknown, high: unknown): this;
  whereLike(column: Cols<Row> | (string & {}), pattern: string): this;
  whereILike(column: Cols<Row> | (string & {}), pattern: string): this;
  whereContains(column: Cols<Row> | (string & {}), value: Json): this;
  whereOverlaps(column: Cols<Row> | (string & {}), value: Json[]): this;
  whereSearch(column: Cols<Row> | (string & {}), text: string, language?: string): this;
  /** Inside a json/jsonb column: `whereJson('meta', 'address.city', 'Chennai')`. */
  whereJson(column: Cols<Row> | (string & {}), path: string | string[], value: unknown): this;
  whereJson(column: Cols<Row> | (string & {}), path: string | string[], op: Operator, value: unknown): this;
  /** A related row exists (filtered joins). */
  whereHas(relation: string, callback?: Grouper): this;
  orWhereHas(relation: string, callback?: Grouper): this;
  whereDoesntHave(relation: string, callback?: Grouper): this;
  // Supabase / PostgREST names
  eq(column: Cols<Row> | (string & {}), value: unknown): this;
  neq(column: Cols<Row> | (string & {}), value: unknown): this;
  gt(column: Cols<Row> | (string & {}), value: unknown): this;
  gte(column: Cols<Row> | (string & {}), value: unknown): this;
  lt(column: Cols<Row> | (string & {}), value: unknown): this;
  lte(column: Cols<Row> | (string & {}), value: unknown): this;
  like(column: Cols<Row> | (string & {}), pattern: string): this;
  ilike(column: Cols<Row> | (string & {}), pattern: string): this;
  is(column: Cols<Row> | (string & {}), value: boolean | null): this;
  in(column: Cols<Row> | (string & {}), values: unknown[]): this;
  contains(column: Cols<Row> | (string & {}), value: Json): this;
  containedBy(column: Cols<Row> | (string & {}), value: Json): this;
  overlaps(column: Cols<Row> | (string & {}), value: Json[]): this;
  textSearch(column: Cols<Row> | (string & {}), query: string, options?: { type?: 'plain' | 'phrase' | 'websearch'; config?: string }): this;
  match(values: Partial<Row> | Record<string, unknown>): this;
  not(column: Cols<Row> | (string & {}), op: string, value: unknown): this;
  or(filters: string): this;
  filter(column: Cols<Row> | (string & {}), op: string, value: unknown): this;
}

export type OrderTerm = { column?: string; fn?: 'count' | 'sum' | 'avg' | 'min' | 'max'; dir?: 'asc' | 'desc'; nulls?: 'first' | 'last' };
type OrderMethod<B> = {
  (column: string, dir?: 'asc' | 'desc', options?: { nulls?: 'first' | 'last' }): B;
  (column: string, options: { ascending?: boolean; nullsFirst?: boolean }): B;
  (term: OrderTerm): B;
};

/** Related rows: their columns, filters, order, limits and their own relations. */
export interface EmbedBuilder extends Conditions<any> {
  select(...columns: Array<string | string[] | Record<string, string>>): this;
  order: OrderMethod<this>;
  orderBy: OrderMethod<this>;
  limit(n: number): this;
  offset(n: number): this;
  preload(relation: string, callback?: Related): this;
  joins(relation: string, callback?: Related): this;
  withCount(relation: string, callback?: Related, as?: string): this;
  withAggregate(relation: string, spec: AggregateSpec, callback?: Related, as?: string): this;
}

export type AggregateSpec = { count?: boolean; sum?: string | string[]; avg?: string | string[]; min?: string | string[]; max?: string | string[] };
export type AggregateResult = {
  count?: number;
  sum?: Record<string, string | number | null>;
  avg?: Record<string, string | number | null>;
  min?: Record<string, unknown>;
  max?: Record<string, unknown>;
};

export interface QueryBuilder<Row = Record<string, unknown>, Insert = Partial<Row>, Update = Partial<Row>>
  extends Conditions<Row>, PromiseLike<Result<Row>> {
  readonly table: string;
  catch<T = never>(onrejected?: (reason: any) => T | PromiseLike<T>): Promise<Result<Row> | T>;
  finally(onfinally?: () => void): Promise<Result<Row>>;
  // shaping
  select(...columns: Array<string | string[] | Record<string, string> | { count?: 'exact'; head?: boolean }>): this;
  order: OrderMethod<this>;
  orderBy: OrderMethod<this>;
  latest(column?: string): this;
  oldest(column?: string): this;
  limit(n: number): this;
  offset(n: number): this;
  page(number: number, size?: number): this;
  range(from: number, to: number): this;
  distinct(...columns: string[]): this;
  preload(relation: string, callback?: Related): this;
  joins(relation: string, callback?: Related): this;
  withCount(relation: string, callback?: Related, as?: string): this;
  withAggregate(relation: string, spec: AggregateSpec, callback?: Related, as?: string): this;
  lock(strength?: 'update' | 'no_key_update' | 'share' | 'key_share', wait?: 'nowait' | 'skip_locked'): this;
  lockForUpdate(options?: { nowait?: boolean; skipLocked?: boolean }): this;
  forShare(options?: { nowait?: boolean; skipLocked?: boolean }): this;
  groupBy(...columns: string[]): this;
  group(...columns: string[]): this;
  having(fn: 'count', op: Operator, value: number): this;
  having(fn: 'sum' | 'avg' | 'min' | 'max', column: string, op: Operator, value: unknown): this;
  having(expression: string, value: unknown): this;
  scopes(...scopes: Array<string | ((q: this) => this | void)>): this;
  scope(...scopes: Array<string | ((q: this) => this | void)>): this;
  unscoped(): this;
  onlyTrashed(): this;
  allowGlobalUpdate(): this;
  single(): PromiseLike<SingleResult<Row>>;
  maybeSingle(): PromiseLike<SingleResult<Row>>;
  returning(mode: 'minimal' | 'representation'): this;
  /** The structured operation this builder sends (GORM's DryRun). */
  toQuery(): Record<string, unknown>;
  // reading
  find(ids?: unknown): Promise<Result<Row>>;
  get(...ids: unknown[]): Promise<Result<Row>>;
  first(id?: unknown): Promise<Row>;
  last(): Promise<Row>;
  take(): Promise<Row>;
  firstOrNull(id?: unknown): Promise<Row | null>;
  sole(): Promise<Row>;
  pluck<K extends Cols<Row>>(column: K): Promise<Array<Row[K]>>;
  pluck(column: string): Promise<unknown[]>;
  count(): Promise<number>;
  exists(): Promise<boolean>;
  sum(column: string): Promise<number | null>;
  avg(column: string): Promise<number | null>;
  min(column: string): Promise<unknown>;
  max(column: string): Promise<unknown>;
  aggregate(spec?: AggregateSpec): Promise<any>;
  paginate(options?: { page?: number; perPage?: number }): Promise<{ data: Row[]; total: number; page: number; perPage: number; totalPages: number }>;
  findInBatches(size: number, callback: (rows: Row[], batch: number) => unknown): Promise<void>;
  each(callback: (row: Row) => unknown): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<Row>;
  // writing
  create(values: Insert, options?: { returning?: 'minimal'; omit?: string[]; only?: string[] }): Promise<Row>;
  create(values: Insert[], options?: { returning?: 'minimal'; omit?: string[]; only?: string[] }): Promise<Row[]>;
  createInBatches(values: Insert[], size?: number): Promise<Row[]>;
  insert(values: Insert | Insert[], options?: { returning?: 'minimal' }): QueryBuilder<Row, Insert, Update>;
  upsert(values: Insert | Insert[], options?: { onConflict?: string | string[]; update?: string[] | false; ignore?: boolean; ignoreDuplicates?: boolean; returning?: 'minimal' }): QueryBuilder<Row, Insert, Update>;
  save(row: Insert | Row): Promise<Row>;
  /** The 0.1 form: one row by primary key. */
  update(id: string | number, values: Update): Promise<Row>;
  update(values: Update, _?: undefined, options?: { returning?: 'minimal' }): QueryBuilder<Row, Insert, Update>;
  updateColumn(column: string, value: unknown): QueryBuilder<Row, Insert, Update>;
  increment(column: string, by?: number, extra?: Update): Promise<Result<Row>>;
  decrement(column: string, by?: number, extra?: Update): Promise<Result<Row>>;
  /** One row by primary key. */
  delete(id: string | number): Promise<Row>;
  delete(options?: { returning?: 'minimal' }): QueryBuilder<Row, Insert, Update>;
  forceDelete(): Promise<Result<Row>>;
  restore(): Promise<Result<Row>>;
  firstOrCreate(attributes: Partial<Row>, defaults?: Partial<Insert>): Promise<Row>;
  firstOrInit(attributes: Partial<Row>, defaults?: Partial<Insert>): Promise<Row | Partial<Row>>;
  updateOrCreate(attributes: Partial<Row>, values?: Update): Promise<Row>;
}

// ── models ─────────────────────────────────────────────────────────────────

export type Relation =
  | { kind: 'belongsTo'; table: string; foreignKey?: string; references?: string; constraint?: string }
  | { kind: 'hasOne' | 'hasMany'; table: string; foreignKey?: string; references?: string; constraint?: string }
  | { kind: 'manyToMany'; table: string; through: string; foreignKey: string; otherKey: string; constraint?: string; throughConstraint?: string };
export function belongsTo(table: string, options?: { foreignKey?: string; references?: string; constraint?: string }): Relation;
export function hasOne(table: string, options?: { foreignKey?: string; references?: string; constraint?: string }): Relation;
export function hasMany(table: string, options?: { foreignKey?: string; references?: string; constraint?: string }): Relation;
export function manyToMany(table: string, options: { through: string; foreignKey: string; otherKey: string; constraint?: string; throughConstraint?: string }): Relation;

export type ColumnDef = string | {
  type: string;
  primaryKey?: boolean;
  identity?: boolean;
  notNull?: boolean;
  nullable?: boolean;
  unique?: boolean;
  /** SQL, as GORM's default tag: "now()", "0", "'draft'". */
  default?: string | number | boolean | null;
  check?: string;
  references?: string;
  onDelete?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
  onUpdate?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
  index?: boolean | { unique?: boolean; name?: string; using?: string; where?: string };
};
export type IndexDef = { columns: string | string[]; unique?: boolean; name?: string; using?: string; where?: string };
export type PolicyDef = { name: string; for?: 'all' | 'select' | 'insert' | 'update' | 'delete'; to?: string | string[]; using?: string; check?: string; as?: 'permissive' | 'restrictive' };

export type Hooks<Row> = {
  beforeSave?(row: any): any;
  beforeCreate?(row: any): any;
  afterCreate?(row: Row): unknown;
  beforeUpdate?(values: any): any;
  afterUpdate?(row: Row): unknown;
  afterSave?(row: Row): unknown;
  beforeDelete?(query: Record<string, unknown>): unknown;
  afterDelete?(row: Row): unknown;
  afterFind?(row: Row): any;
};

export type ModelOptions<Row = Record<string, unknown>> = {
  primaryKey?: string | string[];
  softDelete?: string;
  relations?: Record<string, Relation>;
  hooks?: Hooks<Row>;
  scopes?: Record<string, (q: QueryBuilder<Row, any, any>) => QueryBuilder<Row, any, any> | void>;
  columns?: Record<string, ColumnDef>;
  indexes?: IndexDef[];
  uniques?: Array<string | string[]>;
  checks?: string[];
  policies?: PolicyDef[];
  rowLevelSecurity?: boolean;
};

export interface Association<Related = Record<string, unknown>> {
  find(callback?: (q: QueryBuilder<Related>) => QueryBuilder<Related>): Promise<Related[]>;
  append(related: unknown): Promise<unknown>;
  replace(related: unknown): Promise<unknown>;
  delete(related?: unknown): Promise<unknown>;
  clear(): Promise<unknown>;
  count(): Promise<number>;
}

export type Model<Row = Record<string, unknown>, Insert = Partial<Row>, Update = Partial<Row>> =
  Omit<ModelOptions<Row>, 'scopes'> & {
    table: string;
    scopes?: ModelOptions<Row>['scopes'];
    query(): QueryBuilder<Row, Insert, Update>;
    association(row: unknown, relation: string): Association;
  } & Omit<QueryBuilder<Row, Insert, Update>, 'table' | 'then' | 'catch' | 'finally' | 'scopes'>;

// ── transactions ───────────────────────────────────────────────────────────

export type Ref = { $ref: string };
export interface TransactionClient<TDatabase extends DatabaseDefinition = DefaultDatabase> {
  from<TName extends TableName<TDatabase>>(table: TName): QueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  table<TName extends TableName<TDatabase>>(table: TName): QueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
}
/**
 * Inside `transaction()`, every operation returns a handle: await it after
 * the transaction, or pass `handle.ref('id')` to a later operation.
 */
export type TxHandle<T = unknown> = Promise<T> & { ref(path?: string): Ref; refAll(path?: string): Ref };

// ── raw SQL and migrations (server, secret key) ────────────────────────────

export type SqlResult = { command: string | null; columns: string[]; rows: Record<string, unknown>[] | null; row_count: number; truncated: boolean };
export interface MigrationPlan {
  statements: Array<{ sql: string; params: unknown[] }>;
  sql(text: string, params?: unknown[]): MigrationPlan;
  createTable(table: string, columns: Record<string, ColumnDef>, options?: ModelOptions): MigrationPlan;
  dropTable(table: string, options?: { ifExists?: boolean; cascade?: boolean }): MigrationPlan;
  addColumn(table: string, name: string, def: ColumnDef): MigrationPlan;
  dropColumn(table: string, name: string): MigrationPlan;
  renameColumn(table: string, from: string, to: string): MigrationPlan;
  createIndex(table: string, columns: string | string[], options?: Omit<IndexDef, 'columns'>): MigrationPlan;
  dropIndex(name: string): MigrationPlan;
  enableRowLevelSecurity(table: string): MigrationPlan;
  createPolicy(table: string, policy: PolicyDef): MigrationPlan;
}
export type Migration = { id: string; up: string | string[] | ((m: MigrationPlan) => unknown); down?: string | string[] | ((m: MigrationPlan) => unknown) };
export interface Migrator {
  autoMigrate(...models: Array<{ table: string; columns?: Record<string, ColumnDef> }>): Promise<string[]>;
  hasTable(table: string): Promise<boolean>;
  hasColumn(table: string, column: string): Promise<boolean>;
  hasIndex(table: string, name: string): Promise<boolean>;
  columns(table: string): Promise<Array<{ name: string; type: string; nullable: boolean; default: string | null }>>;
  tables(): Promise<string[]>;
  createTable(table: string, columns: Record<string, ColumnDef>, options?: ModelOptions): Promise<SqlResult[]>;
  dropTable(table: string, options?: { ifExists?: boolean; cascade?: boolean }): Promise<SqlResult[]>;
  renameTable(from: string, to: string): Promise<SqlResult[]>;
  addColumn(table: string, name: string, def: ColumnDef): Promise<SqlResult[]>;
  dropColumn(table: string, name: string): Promise<SqlResult[]>;
  renameColumn(table: string, from: string, to: string): Promise<SqlResult[]>;
  alterColumnType(table: string, name: string, type: string, options?: { using?: string }): Promise<SqlResult[]>;
  setNotNull(table: string, name: string, notNull?: boolean): Promise<SqlResult[]>;
  setDefault(table: string, name: string, value?: string | null): Promise<SqlResult[]>;
  createIndex(table: string, columns: string | string[], options?: Omit<IndexDef, 'columns'>): Promise<SqlResult[]>;
  dropIndex(name: string): Promise<SqlResult[]>;
  addConstraint(table: string, name: string, definition: string): Promise<SqlResult[]>;
  dropConstraint(table: string, name: string): Promise<SqlResult[]>;
  enableRowLevelSecurity(table: string): Promise<SqlResult[]>;
  createPolicy(table: string, policy: PolicyDef): Promise<SqlResult[]>;
  dropPolicy(table: string, name: string): Promise<SqlResult[]>;
  plan(): MigrationPlan;
}

// ── realtime, storage, GraphQL, functions ──────────────────────────────────

export type Change<T = Record<string, unknown>> = { type: 'insert' | 'update' | 'delete'; table: string; record?: T; old?: Partial<T> };

export interface RealtimeChannel<T = Record<string, unknown>> {
  onChange(listener: (change: Change<T>) => void): RealtimeChannel<T>;
  onBroadcast(event: string, listener: (payload: Record<string, unknown>, event?: string) => void): RealtimeChannel<T>;
  onPresence(listener: (update: { event: 'presence_state' | 'presence_diff'; state: Record<string, unknown> }) => void): RealtimeChannel<T>;
  onError(listener: (error: Error & { code?: string }) => void): RealtimeChannel<T>;
  on(event: string, listener: (...args: any[]) => void): RealtimeChannel<T>;
  sendBroadcast(event: string, payload?: Record<string, unknown>): RealtimeChannel<T>;
  ready(): Promise<void>;
  subscribe(): RealtimeChannel<T>;
  unsubscribe(): void;
}

export type StorageObject = {
  id: string;
  path: string;
  content_type: string;
  expected_size: number;
  status: 'ready' | 'pending' | 'uploading';
  inserted_at?: string;
  uploaded_at?: string | null;
};

export interface ObjectStorageClient {
  list(): Promise<StorageObject[]>;
  upload(path: string, body: string | Blob | ArrayBuffer | ArrayBufferView, options: { contentType: string }): Promise<StorageObject>;
  createSignedDownloadUrl(id: string): Promise<{ object: StorageObject; signed_url: string; expires_at: string }>;
  download(id: string): Promise<{ data: Uint8Array; contentType: string | null }>;
  remove(id: string): Promise<null>;
}

export type GraphQLResult<T = any> = { data?: T; errors?: Array<{ message: string; path?: Array<string | number>; extensions?: Record<string, unknown> }> };
export interface GraphQLClient {
  <T = any>(query: string, variables?: Record<string, unknown>, options?: string | { operationName?: string; persisted?: boolean }): Promise<GraphQLResult<T>>;
  /** A live query: the answer now, and again when a row it reads changes. */
  subscribe<T = any>(query: string, variables: Record<string, unknown>, onResult: (result: GraphQLResult<T>) => void): { unsubscribe(): void };
}

export type LiveApi = {
  mode: string;
  tables: Array<{ name: string; kind: 'table' | 'view'; writable: boolean; primary_key: string[]; comment: string | null; foreign_keys: Array<{ name: string; columns: string[]; ref_table: string; ref_columns: string[] }>; columns: Array<{ name: string; type: string; display_type?: string; not_null: boolean; has_default: boolean; read_only: boolean; comment: string | null }> }>;
  functions: Array<{ name: string; args: Array<{ name: string; type: string }>; required: string[]; returns: string; returns_set: boolean; comment: string | null }>;
  hidden?: Array<{ name: string; kind: string; reason: string }>;
};

// ── the client ─────────────────────────────────────────────────────────────

export type DatabaseDefinition = { public: { Tables: Record<string, { Row: any; Insert: any; Update: any }>; Functions?: Record<string, { Args: any; Returns: any }> } };
export type DefaultDatabase = { public: { Tables: Record<string, { Row: Record<string, any>; Insert: Record<string, any>; Update: Record<string, any> }>; Functions: Record<string, { Args: Record<string, unknown>; Returns: unknown }> } };
type TableName<D extends DatabaseDefinition> = keyof D['public']['Tables'] & string;
type RowOf<D extends DatabaseDefinition, T extends TableName<D>> = D['public']['Tables'][T]['Row'];
type InsertOf<D extends DatabaseDefinition, T extends TableName<D>> = D['public']['Tables'][T]['Insert'];
type UpdateOf<D extends DatabaseDefinition, T extends TableName<D>> = D['public']['Tables'][T]['Update'];
type Functions<D extends DatabaseDefinition> = D['public'] extends { Functions: infer F } ? F : Record<string, { Args: Record<string, unknown>; Returns: unknown }>;

export interface PlexivoClient<TDatabase extends DatabaseDefinition = DefaultDatabase> {
  readonly apiUrl: string;
  readonly lastTraceId: string | null;
  auth: AuthClient;
  orgs: OrgsClient;
  from<TName extends TableName<TDatabase>>(table: TName): QueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  table<TName extends TableName<TDatabase>>(table: TName): QueryBuilder<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  model<TName extends TableName<TDatabase>>(table: TName, options?: ModelOptions<RowOf<TDatabase, TName>>): Model<RowOf<TDatabase, TName>, InsertOf<TDatabase, TName>, UpdateOf<TDatabase, TName>>;
  /**
   * Operations that commit together or not at all. Record them without
   * awaiting; pass one result to the next with `handle.ref('id')`.
   * Resolves to each operation's result, in order.
   */
  transaction(callback: (tx: TransactionClient<TDatabase>) => unknown): Promise<any[]>;
  rpc<TName extends keyof Functions<TDatabase> & string>(fn: TName, args?: Record<string, unknown>): Promise<{ data: Functions<TDatabase>[TName] extends { Returns: infer R } ? R : unknown; count: number | null; error: null }>;
  graphql: GraphQLClient;
  functions: { invoke<T = any>(name: string, options?: { body?: unknown; method?: string; headers?: Record<string, string> }): Promise<{ data: T; status: number; headers: Headers }> };
  channel<T = Record<string, unknown>>(topic?: string, options?: { filter?: string; presence?: Record<string, unknown> }): RealtimeChannel<T>;
  storage: ObjectStorageClient;
  getApi(): Promise<LiveApi>;
  getSchema(): Promise<{ version: string; schema: 'public'; tables: Record<string, unknown> }>;
  // Server only, with the secret key:
  sql<T = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  raw<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<{ command: string | null; rowCount: number }>;
  sqlTransaction(statements: Array<string | { sql: string; params?: unknown[] }>): Promise<SqlResult[]>;
  migrator: Migrator;
  migrate(migrations: Migration[], options?: { table?: string }): Promise<string[]>;
  rollback(migrations: Migration[], options?: { steps?: number; table?: string }): Promise<string[]>;
}

export function createClient<TDatabase extends DatabaseDefinition = DefaultDatabase>(apiUrl: string, key: string, options?: {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  initialSession?: Session;
  persistSession?: boolean;
  storageKey?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  realtimeClientId?: string;
}): PlexivoClient<TDatabase>;
