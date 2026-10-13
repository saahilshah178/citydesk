/** Errors raised by the Open311 client. Each carries a stable `code` so callers can branch on it. */

export type Open311ErrorCode =
  | 'write_blocked'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'bad_response'
  | 'not_configured';

export class Open311Error extends Error {
  readonly code: Open311ErrorCode;
  /** HTTP status from the city's server, when there was one. */
  readonly status?: number;
  /** True when retrying the same call later may work. */
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: Open311ErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'Open311Error';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (code === 'rate_limited' || code === 'upstream_unavailable');
    this.details = opts.details;
  }
}

/** Thrown before any network call when a write targets something other than a sandbox. */
export class WriteBlockedError extends Open311Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super('write_blocked', message, { retryable: false, details });
    this.name = 'WriteBlockedError';
  }
}
