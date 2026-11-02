export const appConfig = {
  apiPrefix: '/api/v1',
  jsonBodyLimit: '1mb',
  bcryptRounds: 12,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  // Sliding session: expiry is pushed out once the last refresh is older than this; last_seen_at is written at most this often.
  sessionRefreshAfterMs: 24 * 60 * 60 * 1000,
  sessionTouchMs: 5 * 60 * 1000,
  passwordResetTtlMs: 60 * 60 * 1000,
} as const;
