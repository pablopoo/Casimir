/** Postgres SQLSTATEs — surfaced by both `pg` and PGlite. */
const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * Does this error carry the given Postgres SQLSTATE anywhere in its cause
 * chain?
 *
 * The SQLSTATE rides on the DRIVER error, and drizzle wraps that in a
 * `DrizzleQueryError` whose own `code` is undefined — so the `cause` chain
 * has to be walked, not just the frame that was thrown. Verified against
 * PGlite in `api-delete.test.ts`; `pg` reports the same code the same way.
 * Bounded so a self-referencing `cause` cannot spin.
 */
export function hasSqlState(err: unknown, code: string): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cursor !== 'object' || cursor === null) {
      return false;
    }
    if ('code' in cursor && cursor.code === code) {
      return true;
    }
    cursor = 'cause' in cursor ? cursor.cause : undefined;
  }
  return false;
}

/** The project row vanished under an insert that references it. */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, PG_FOREIGN_KEY_VIOLATION);
}
