export type Credentials = { email: string; password: string; mfa_code?: string };
export type AppUser = {
  id: string;
  email: string;
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
export type Change<T = unknown> = { event: 'post' | 'put' | 'patch' | 'delete'; table: string; record: T };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DatabaseDefinition = { public: { Tables: Record<string, { Row: unknown; Insert: unknown; Update: unknown }> } };
export type DefaultDatabase = { public: { Tables: Record<string, { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> }> } };

export interface TableClient<TRow = Record<string, unknown>, TInsert = Partial<TRow>, TUpdate = Partial<TRow>> {
  select(): Promise<TRow[]>;
  insert(value: TInsert): Promise<TRow>;
  get(id: string): Promise<TRow>;
  update(id: string, value: TUpdate): Promise<TRow>;
  delete(id: string): Promise<{ id: string }>;
}

export interface RealtimeChannel<T = unknown> {
  onChange(listener: (change: Change<T>) => void): RealtimeChannel<T>;
  onBroadcast(event: string, listener: (payload: Record<string, unknown>) => void): RealtimeChannel<T>;
  onPresence(listener: (update: { event: 'presence_state' | 'presence_diff'; state: Record<string, unknown> }) => void): RealtimeChannel<T>;
  sendBroadcast(event: string, payload?: Record<string, unknown>): RealtimeChannel<T>;
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

export interface PlexivoClient<TDatabase extends DatabaseDefinition = DefaultDatabase> {
  readonly apiUrl: string;
  readonly lastTraceId: string | null;
  auth: {
    signUp(credentials: Credentials): Promise<Session>;
    signInWithPassword(credentials: Credentials): Promise<Session>;
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
    onAuthStateChange(listener: (event: string, session: Session | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
    mfa: {
      enroll(): Promise<{ factor_type: 'totp'; secret: string; uri: string; status: 'pending' }>;
      verify(input: { code: string }): Promise<{ factor_type: 'totp'; status: 'enabled' }>;
      unenroll(input: { password: string }): Promise<void>;
    };
  };
  from<TName extends keyof TDatabase['public']['Tables'] & string>(table: TName): TableClient<
    TDatabase['public']['Tables'][TName]['Row'],
    TDatabase['public']['Tables'][TName]['Insert'],
    TDatabase['public']['Tables'][TName]['Update']
  >;
  channel<T = unknown>(table?: string): RealtimeChannel<T>;
  storage: ObjectStorageClient;
  getSchema(): Promise<{ version: string; schema: 'public'; tables: Record<string, unknown> }>;
}

export interface PlexivoError extends Error {
  status: number;
  code?: string;
  traceId: string | null;
}

export function createClient<TDatabase extends DatabaseDefinition = DefaultDatabase>(apiUrl: string, publishableKey: string, options?: {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  initialSession?: Session;
  persistSession?: boolean;
  storageKey?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  realtimeClientId?: string;
}): PlexivoClient<TDatabase>;
