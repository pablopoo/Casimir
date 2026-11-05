/** Versioned Casimir native artifact protocol. This module has no runtime imports. */
export const CASIMIR_LIMITS: Readonly<{
  compressed: number;
  expanded: number;
  manifest: number;
  files: number;
}> = {
  compressed: 64 * 1024 * 1024,
  expanded: 256 * 1024 * 1024,
  manifest: 1024 * 1024,
  files: 4096,
};
export type RuntimeDescriptor = {
  protocol: 1;
  profile: 'node-sqlite-v1';
  sdkVersion: string;
  runtimeId: string;
  platform: 'linux/amd64';
  nodeAbi: string;
};
export type CasimirFile = { path: string; size: number; sha256: string };
export type CasimirManifest = RuntimeDescriptor & {
  entry: 'dist/ssr/app.js';
  files: Array<CasimirFile>;
  migrations: Array<{ name: string; path: string; sha256: string }>;
  envKeys: Array<string>;
  compatibilityEntry: string | null;
};
const runtimeKeys = ['protocol', 'profile', 'sdkVersion', 'runtimeId', 'platform', 'nodeAbi'];
function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown, keys: Array<string>, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code);
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== keys.length || keys.some((k) => !Object.hasOwn(obj, k))) {
    fail(code);
  }
  return obj;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function runtime(value: Record<string, unknown>): RuntimeDescriptor {
  if (
    value.protocol !== 1 ||
    value.profile !== 'node-sqlite-v1' ||
    value.platform !== 'linux/amd64' ||
    typeof value.sdkVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.sdkVersion) ||
    !digest(value.runtimeId) ||
    typeof value.nodeAbi !== 'string' ||
    !/^\d{1,5}$/.test(value.nodeAbi)
  ) {
    fail('runtime_descriptor');
  }
  return Object.fromEntries(runtimeKeys.map((k) => [k, value[k]])) as RuntimeDescriptor;
}
export function parseRuntimeDescriptor(value: unknown): RuntimeDescriptor {
  return runtime(record(value, runtimeKeys, 'runtime_keys'));
}
export function assertCasimirRuntime(actual: RuntimeDescriptor, expected: RuntimeDescriptor): void {
  const a = runtime(actual as unknown as Record<string, unknown>),
    b = parseRuntimeDescriptor(expected);
  if (
    runtimeKeys.some((k) => a[k as keyof RuntimeDescriptor] !== b[k as keyof RuntimeDescriptor])
  ) {
    fail('runtime_mismatch');
  }
}
export function validateCasimirPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    value.normalize('NFC') !== value ||
    // eslint-disable-next-line no-control-regex -- Reject ASCII control bytes before any filesystem use.
    /[\\\x00-\x1f\x7f:?#%]/.test(value)
  ) {
    fail('file_path');
  }
  const parts = value.split('/');
  if (
    parts.some(
      (p, i) =>
        !p ||
        p === '.' ||
        p === '..' ||
        (p.startsWith('.') &&
          !(
            i === 2 &&
            p === '.vite' &&
            /^dist\/(ssr|client)\/\.vite\/(manifest|ssr-manifest)\.json$/.test(value)
          )) ||
        p === 'node_modules',
    ) ||
    !/^(dist\/(ssr|client)\/|db\/migrations\/|compatibility\/)/.test(value) ||
    /\.(node|env)$/i.test(value)
  ) {
    fail('file_path');
  }
  return value;
}
export function parseCasimirManifest(value: unknown): CasimirManifest {
  const obj = record(
    value,
    [...runtimeKeys, 'entry', 'files', 'migrations', 'envKeys', 'compatibilityEntry'],
    'manifest_keys',
  );
  const descriptor = runtime(obj);
  if (obj.entry !== 'dist/ssr/app.js') {
    fail('entry');
  }
  if (
    !Array.isArray(obj.files) ||
    obj.files.length < 1 ||
    obj.files.length > CASIMIR_LIMITS.files
  ) {
    fail('file_count');
  }
  const seen = new Set<string>();
  let total = 0;
  const files = obj.files.map((item) => {
    const f = record(item, ['path', 'size', 'sha256'], 'file_keys');
    const path = validateCasimirPath(f.path);
    const collision = path.toLowerCase();
    if (seen.has(collision)) {
      fail('file_duplicate');
    }
    seen.add(collision);
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) {
      fail('file_size');
    }
    total += f.size;
    if (total > CASIMIR_LIMITS.expanded) {
      fail('expanded_limit');
    }
    if (!digest(f.sha256)) {
      fail('file_hash');
    }
    return { path, size: f.size, sha256: f.sha256 };
  });
  if (!files.some((f) => f.path === obj.entry)) {
    fail('entry_missing');
  }
  if (files.some((f, i) => i > 0 && f.path <= files[i - 1]!.path)) {
    fail('file_order');
  }
  if (!Array.isArray(obj.migrations)) {
    fail('migrations');
  }
  const names = new Set<string>();
  const migrations = obj.migrations.map((item) => {
    const m = record(item, ['name', 'path', 'sha256'], 'migration_keys');
    if (typeof m.name !== 'string' || !/^[a-zA-Z0-9_-]+\.sql$/.test(m.name) || names.has(m.name)) {
      fail('migration_name');
    }
    names.add(m.name);
    if (
      m.path !== `db/migrations/${m.name}` ||
      !digest(m.sha256) ||
      !files.some((f) => f.path === m.path && f.sha256 === m.sha256)
    ) {
      fail('migration_file');
    }
    return { name: m.name, path: m.path as string, sha256: m.sha256 };
  });
  if (
    migrations.some((m, i) => i > 0 && m.name <= migrations[i - 1]!.name) ||
    files.some(
      (f) => f.path.startsWith('db/migrations/') && !migrations.some((m) => m.path === f.path),
    )
  ) {
    fail('migration_order');
  }
  if (
    !Array.isArray(obj.envKeys) ||
    obj.envKeys.length > 256 ||
    obj.envKeys.some(
      (k) =>
        typeof k !== 'string' ||
        !/^[A-Z_][A-Z0-9_]{0,127}$/.test(k) ||
        k.startsWith('VITE_') ||
        k.startsWith('CASIMIR_') ||
        k === 'VOID_TOKEN',
    ) ||
    new Set(obj.envKeys).size !== obj.envKeys.length
  ) {
    fail('env_keys');
  }
  if (
    obj.compatibilityEntry !== null &&
    (typeof obj.compatibilityEntry !== 'string' ||
      !obj.compatibilityEntry.startsWith('compatibility/') ||
      !files.some((f) => f.path === obj.compatibilityEntry))
  ) {
    fail('compatibility_entry');
  }
  return {
    ...descriptor,
    entry: obj.entry,
    files,
    migrations,
    envKeys: obj.envKeys as Array<string>,
    compatibilityEntry: obj.compatibilityEntry as string | null,
  };
}
