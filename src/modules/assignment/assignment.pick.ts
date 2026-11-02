// The two ways of choosing one person out of a team. Pure, so the fairness rules can be tested without a database.

// Round robin: the member after the one who got the previous record, wrapping round. Members are taken in a fixed order (by id), so the
// rotation is stable when people join or leave; if the previous person left, it continues from where their id would have been.
export function nextRoundRobin(memberIds: readonly string[], lastUserId: string | null): string | null {
  if (memberIds.length === 0) return null;
  const sorted = [...memberIds].sort();
  return (lastUserId === null ? undefined : sorted.find((id) => id > lastUserId)) ?? sorted[0] ?? null;
}

// Least loaded: whoever has the fewest open items; ties go to the lowest id so the choice is repeatable.
export function leastLoaded(loads: readonly { userId: string; open: number }[]): string | null {
  const [best] = [...loads].sort((a, b) => a.open - b.open || a.userId.localeCompare(b.userId));
  return best?.userId ?? null;
}
