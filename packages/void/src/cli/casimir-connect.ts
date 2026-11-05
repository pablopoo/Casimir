import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  lstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  parseRuntimeDescriptor,
  assertCasimirRuntime,
  type RuntimeDescriptor,
} from '@void/deploy-core';
import { dirname, join } from 'pathslash';
import { CasimirClient, casimirOrigin, type CasimirCredential } from './casimir-client.ts';
import { writeDeploymentPlatform } from './project.ts';
export type CasimirLink = Readonly<{
  origin: string;
  runtime: RuntimeDescriptor;
  projectId?: string;
  slug?: string;
}>;
export function writeCasimirJson(path: string, value: unknown, privateFile = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomBytes(8).toString('hex');
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: privateFile ? 0o600 : 0o644,
  });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function storePath(): string {
  return join(
    process.env.CASIMIR_CONFIG_DIR || join(homedir(), '.config', 'casimir'),
    'credentials.json',
  );
}
function savedCredentials(): Record<string, string> {
  let stat;
  try {
    stat = lstatSync(storePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('unsafe_casimir_credentials');
  }
  const value = JSON.parse(readFileSync(storePath(), 'utf8'));
  if (
    !value ||
    value.kind !== 'casimir' ||
    !value.tokens ||
    typeof value.tokens !== 'object' ||
    Array.isArray(value.tokens)
  ) {
    throw new Error('invalid_casimir_credentials');
  }
  for (const [origin, token] of Object.entries(value.tokens)) {
    if (
      casimirOrigin(origin) !== origin ||
      typeof token !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(token)
    ) {
      throw new Error('invalid_casimir_credentials');
    }
  }
  return value.tokens;
}
export function readCasimirCredential(origin: string): CasimirCredential {
  origin = casimirOrigin(origin);
  if (process.env.CASIMIR_TOKEN) {
    if (!process.env.CASIMIR_API_URL || casimirOrigin(process.env.CASIMIR_API_URL) !== origin) {
      throw new Error('credential_origin');
    }
    return { origin, token: process.env.CASIMIR_TOKEN };
  }
  const token = savedCredentials()[origin];
  if (!token) {
    throw new Error('casimir_credentials_required');
  }
  return { origin, token };
}
export function readCasimirLink(root: string): CasimirLink {
  const value = JSON.parse(readFileSync(join(root, '.void/casimir.json'), 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['origin', 'runtime', 'projectId', 'slug'].includes(k))
  ) {
    throw new Error('invalid_casimir_link');
  }
  const origin = casimirOrigin(value.origin);
  const runtime = parseRuntimeDescriptor(value.runtime);
  if (
    (value.projectId === undefined) !== (value.slug === undefined) ||
    (value.projectId !== undefined &&
      (!/^proj_[a-z0-9]{12}$/.test(value.projectId) || typeof value.slug !== 'string'))
  ) {
    throw new Error('invalid_casimir_link');
  }
  return {
    origin,
    runtime,
    ...(value.projectId ? { projectId: value.projectId, slug: value.slug } : {}),
  };
}
export async function runCasimirConnect(root: string, url: string): Promise<void> {
  const origin = casimirOrigin(url);
  const credential = readCasimirCredential(origin);
  const runtime = await new CasimirClient(origin, credential).connect();
  let prior: CasimirLink | undefined;
  try {
    prior = readCasimirLink(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (prior && prior.origin !== origin) {
    throw new Error('casimir_link_origin_changed');
  }
  const retryFile = join(root, '.void/casimir.retry.json');
  try {
    const retry = JSON.parse(readFileSync(retryFile, 'utf8'));
    if (!retry.finished) {
      if (retry.origin !== origin) {
        throw new Error('casimir_retry_target_changed');
      }
      assertCasimirRuntime(retry.runtime, runtime);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const tokens = savedCredentials();
  tokens[origin] = credential.token;
  writeCasimirJson(storePath(), { kind: 'casimir', tokens }, true);
  writeCasimirJson(join(root, '.void/casimir.json'), { ...prior, origin, runtime });
  writeDeploymentPlatform(root, 'casimir');
  console.log(`Connected to Casimir at ${origin}.`);
}
