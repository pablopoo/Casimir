import { R2_CONCURRENCY, uploadPool } from './concurrency.ts';

/** Find only project-scoped objects; legacy stores have separate placement rules. */
export async function findR2Assets(
  r2: R2Bucket,
  projectId: string,
  requiredHashes: ReadonlySet<string>,
): Promise<Map<string, R2Object>> {
  const found = new Map<string, R2Object>();
  if (requiredHashes.size === 0) {
    return found;
  }
  const prefix = `assets/${projectId}/`;
  // A small delta should not scan the project's entire retained history. Keep
  // direct probes within one bounded wave; large manifests still use LIST so
  // thousands of files cannot exhaust the per-request subrequest budget.
  if (requiredHashes.size <= R2_CONCURRENCY) {
    await uploadPool([...requiredHashes], R2_CONCURRENCY, async (hash) => {
      const object = await r2.head(`${prefix}${hash}`);
      if (object) {
        found.set(hash, object);
      }
    });
    return found;
  }
  let cursor: string | undefined;
  do {
    const listed = await r2.list({ prefix, cursor, limit: 1000 });
    for (const object of listed.objects) {
      const hash = object.key.slice(prefix.length);
      if (requiredHashes.has(hash)) {
        found.set(hash, object);
      }
    }
    if (found.size === requiredHashes.size) {
      break;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return found;
}

/** Active deployment metadata is protected from platform GC until cutover. */
export function persistedR2AssetSizes(raw: string | null): Map<string, number> {
  const sizes = new Map<string, number>();
  const conflicting = new Set<string>();
  if (!raw) {
    return sizes;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return sizes;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return sizes;
  }
  for (const value of Object.values(manifest)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const entry = value as { hash?: unknown; size?: unknown; store?: unknown; scope?: unknown };
    if (
      entry.store === 'r2' &&
      entry.scope === 'project' &&
      typeof entry.hash === 'string' &&
      /^[0-9a-f]{32}$/.test(entry.hash) &&
      typeof entry.size === 'number' &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0
    ) {
      if (sizes.has(entry.hash) && sizes.get(entry.hash) !== entry.size) {
        conflicting.add(entry.hash);
        sizes.delete(entry.hash);
      } else if (!conflicting.has(entry.hash)) {
        sizes.set(entry.hash, entry.size);
      }
    }
  }
  return sizes;
}

/** Preflight is advisory: finalization protects its hashes from GC, then verifies presence. */
export async function findMissingR2Assets(
  r2: R2Bucket,
  projectId: string,
  manifest: Readonly<Record<string, { hash: string; size: number }>>,
): Promise<Array<string>> {
  const entries = Object.entries(manifest);
  const found = await findR2Assets(r2, projectId, new Set(entries.map(([, entry]) => entry.hash)));
  return entries
    .filter(([, entry]) => found.get(entry.hash)?.size !== entry.size)
    .map(([path]) => path);
}
