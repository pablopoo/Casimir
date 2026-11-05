import { canonicalJson, type MigrationFile, type MigrationPlan } from '@void/deploy-core';
export function isMvpDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function record(value: unknown, keys: Array<string>): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  ) {
    throw new Error('job_result_invalid');
  }
  return value as Record<string, unknown>;
}
function file(value: unknown): MigrationFile {
  const row = record(value, ['name', 'sql', 'sha256']);
  if (
    typeof row.name !== 'string' ||
    row.name.length > 512 ||
    typeof row.sql !== 'string' ||
    row.sql.length > 4 * 1024 * 1024 ||
    !isMvpDigest(row.sha256)
  ) {
    throw new Error('job_result_invalid');
  }
  return { name: row.name, sql: row.sql, sha256: row.sha256 };
}
/** The native runner revalidates content hashes, policy and state inside apply. */
export function parseMvpPlanResult(value: unknown): MigrationPlan {
  const row = record(value, [
    'files',
    'pending',
    'priorSchemaDigest',
    'priorHistoryDigest',
    'fingerprint',
  ]);
  if (
    !Array.isArray(row.files) ||
    row.files.length > 4096 ||
    !Array.isArray(row.pending) ||
    row.pending.length > row.files.length ||
    !isMvpDigest(row.priorSchemaDigest) ||
    !isMvpDigest(row.priorHistoryDigest) ||
    !isMvpDigest(row.fingerprint)
  ) {
    throw new Error('job_result_invalid');
  }
  const files = row.files.map(file),
    pending = row.pending.map(file);
  if (canonicalJson(pending) !== canonicalJson(files.slice(files.length - pending.length))) {
    throw new Error('job_result_invalid');
  }
  return {
    files,
    pending,
    priorSchemaDigest: row.priorSchemaDigest,
    priorHistoryDigest: row.priorHistoryDigest,
    fingerprint: row.fingerprint,
  };
}
