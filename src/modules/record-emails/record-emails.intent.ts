export type ReplyIntent = 'interested' | 'not_interested' | 'unclear';

// ponytail: plain phrase matching on the reply text. It handles the common short answers ("yes, tell me more", "not interested") and
// leaves anything else as 'unclear' for a person to read. Swap in an LLM classifier if the unclear share turns out to be large.
const NOT_INTERESTED = [
  /\bnot\s+(really\s+)?interested\b/,
  /\bno\s+longer\s+interested\b/,
  /\bno,?\s+thank(s|\s+you)\b/,
  /\b(un)?subscribe\b/,
  /\bremove\s+(me|us)\b/,
  /\bstop\s+(emailing|sending|contacting|messaging)\b/,
  /\b(do\s+not|don'?t)\s+(contact|email|message)\b/,
  /\bnot\s+(looking|required|needed|a\s+fit|right\s+now)\b/,
  /\bnot\s+now\b/,
  /^\s*(no|nope|nah)[\s.!]*$/,
];

const INTERESTED = [
  /\binterested\b/,
  /\b(yes|yeah|yep|sure|definitely|absolutely)\b/,
  /\bsounds\s+(good|great|interesting)\b/,
  /\b(call|ring|phone)\s+me\b/,
  /\btell\s+me\s+more\b/,
  /\bmore\s+(info|information|details)\b/,
  /\b(pricing|price|prices|quote|proposal|brochure|demo|cost|rates)\b/,
  /\b(schedule|book|set\s+up|arrange)\s+(a\s+)?(call|meeting|demo|time|visit)\b/,
  /\blet'?s\s+(talk|connect|chat|discuss|meet)\b/,
];

// The reply text arrives with the quoted original already removed. Negatives are checked first because "not interested" contains "interested".
export function classifyReply(text: string): ReplyIntent {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (NOT_INTERESTED.some((re) => re.test(t))) return 'not_interested';
  if (INTERESTED.some((re) => re.test(t))) return 'interested';
  return 'unclear';
}
