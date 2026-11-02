const DAY_MS = 24 * 60 * 60 * 1000;

export const purgeCutoff = (retentionDays: number, now = new Date()) => new Date(now.getTime() - retentionDays * DAY_MS);
