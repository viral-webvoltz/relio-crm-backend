export const MAX_MENTIONS = 20;

const TOKEN = /@\[[^\]]*\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

// Unique, lowercased user ids from `@[Full Name](user:<uuid>)` tokens, capped. Validity (active, same org) is checked by the caller.
export function parseMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(TOKEN)) {
    const id = m[1]?.toLowerCase();
    if (id) ids.add(id);
    if (ids.size >= MAX_MENTIONS) break;
  }
  return [...ids];
}
