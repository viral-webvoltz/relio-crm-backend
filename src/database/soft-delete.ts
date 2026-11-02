// Shared bits of soft delete: what to write, and spotting a unique violation raised while restoring.
export const softDeleteSet = (userId: string) => ({ deletedAt: new Date(), deletedBy: userId });
export const restoreSet = { deletedAt: null, deletedBy: null } as const;

export function isUniqueViolation(error: unknown) {
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}
