// Errors the SDK throws. Every API failure is a PlexivoError carrying what the
// Data API said (code, message, hint, SQLSTATE) and the trace id to quote to
// support. RecordNotFoundError is what first(), last() and take() throw when
// no row matches, like GORM's ErrRecordNotFound.

export class PlexivoError extends Error {
  constructor(message, {status = 0, code, hint, sqlstate, traceId = null, details, operation} = {}) {
    super(message);
    this.name = 'PlexivoError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.sqlstate = sqlstate;
    this.traceId = traceId;
    if (details !== undefined) this.details = details;
    if (operation !== undefined) this.operation = operation;
  }
}

export class RecordNotFoundError extends PlexivoError {
  constructor(table) {
    super(`record not found in ${table}`, {status: 404, code: 'record_not_found'});
    this.name = 'RecordNotFoundError';
    this.table = table;
  }
}

/** True for RecordNotFoundError, and for a 404 from a lookup by primary key. */
export const isNotFound = (error) =>
  error instanceof RecordNotFoundError || error?.code === 'record_not_found' || error?.code === 'not_found';

/** True when a unique constraint refused the write (SQLSTATE 23505). */
export const isUniqueViolation = (error) => error?.code === 'unique_violation';

/** True when row-level security or a grant refused the request. */
export const isPermissionDenied = (error) => error?.code === 'permission_denied' || error?.status === 403;

export function apiError(response, payload, lastTraceId) {
  const e = payload?.error || {};
  const failed = response.headers?.get?.('x-plexivo-failed-operation') ?? response.headers?.get?.('x-plexivo-failed-statement');
  return new PlexivoError(e.message || e.code || `HTTP ${response.status}`, {
    status: response.status,
    code: e.code,
    hint: e.hint ?? undefined,
    sqlstate: e.sqlstate ?? undefined,
    traceId: payload?.trace_id || lastTraceId,
    details: e.details,
    operation: failed == null ? undefined : Number(failed)
  });
}
