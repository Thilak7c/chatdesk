/** Escape `%`, `_` and `\` so user input matches literally inside a LIKE/ILIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%value%` with LIKE metacharacters escaped — for "contains" searches. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}
