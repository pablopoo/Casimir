import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chown, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstallIdentity } from '../lifecycle/identity.ts';
import {
  atomicPrivateJson,
  privateState,
  readPrivate,
  withStateLock,
} from '../lifecycle/identity.ts';
import { generateManagedAuthSecret } from '../../project-secrets.ts';
import { parseIdentityPolicy } from './identity-policy.ts';
import type { IdentityPolicy } from './identity-policy.ts';

const OWNER_FILENAME = 'management-owner.json';
const API_FILENAME = 'management.json';
const MAX_CONFIG_BYTES = 65_536;
const OWNER_BASE_KEYS = [
  'authSetupToken',
  'format',
  'installationId',
  'jwtSecret',
  'ownershipNonce',
  'projectSecretActiveKeyVersion',
  'projectSecretKeysJson',
  'operatorId',
  'projectId',
].sort();
const OWNER_KEYS_WITH_IDENTITY_NETWORK = [...OWNER_BASE_KEYS, 'identityNetwork'].sort();

export type CasimirManagementOwner = Readonly<{
  format: 1;
  installationId: string;
  ownershipNonce: string;
  jwtSecret: string;
  authSetupToken: string;
  projectSecretKeysJson: string;
  projectSecretActiveKeyVersion: '1';
  operatorId: string;
  projectId: string;
  identityNetwork?: IdentityPolicy;
}>;

export type CasimirManagementConfig = CasimirManagementOwner;

export function canonicalManagementJson(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, JSON.parse(canonicalManagementJson(entry))]),
      ),
    );
  }
  return JSON.stringify(value);
}

export function validateCasimirManagementOwner(value: unknown): CasimirManagementOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('management_owner_invalid');
  }
  const owner = value as Record<string, unknown>;
  const keys = Object.keys(owner).sort();
  const expectedKeys = Object.hasOwn(owner, 'identityNetwork')
    ? OWNER_KEYS_WITH_IDENTITY_NETWORK
    : OWNER_BASE_KEYS;
  const exactKeys = keys.length === expectedKeys.length && keys.join(',') === expectedKeys.join(',');
  let identityNetwork: IdentityPolicy | undefined;
  if (Object.hasOwn(owner, 'identityNetwork')) {
    try {
      identityNetwork = parseIdentityPolicy(owner.identityNetwork);
    } catch {
      throw new Error('management_owner_invalid');
    }
  }
  const projectKeys = (() => {
    try {
      const parsed = JSON.parse(String(owner.projectSecretKeysJson)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  })();
  const encodedKey = projectKeys?.['1'];
  const keyBytes = typeof encodedKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(encodedKey)
    ? Buffer.from(encodedKey, 'base64')
    : Buffer.alloc(0);
  if (
    !exactKeys ||
    owner.format !== 1 ||
    typeof owner.installationId !== 'string' || !/^[a-f0-9]{32}$/.test(owner.installationId) ||
    typeof owner.ownershipNonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(owner.ownershipNonce) ||
    typeof owner.jwtSecret !== 'string' || !/^[a-f0-9]{64}$/.test(owner.jwtSecret) ||
    typeof owner.authSetupToken !== 'string' || !/^[a-f0-9]{64}$/.test(owner.authSetupToken) ||
    owner.jwtSecret === owner.authSetupToken ||
    typeof owner.projectSecretKeysJson !== 'string' ||
    !projectKeys || Object.keys(projectKeys).length !== 1 ||
    keyBytes.byteLength !== 32 || keyBytes.toString('base64') !== encodedKey ||
    owner.projectSecretActiveKeyVersion !== '1' ||
    typeof owner.operatorId !== 'string' || !/^user_[a-z0-9]{12}$/.test(owner.operatorId) ||
    typeof owner.projectId !== 'string' || !/^proj_[a-z0-9]{12}$/.test(owner.projectId)
  ) {
    throw new Error('management_owner_invalid');
  }
  return {
    ...(owner as unknown as CasimirManagementOwner),
    ...(identityNetwork ? { identityNetwork } : {}),
  };
}

export function validateCasimirManagementConfig(value: unknown): CasimirManagementConfig {
  return validateCasimirManagementOwner(value);
}

export function managementOwnerMatches(
  leftValue: CasimirManagementOwner,
  rightValue: CasimirManagementOwner,
): boolean {
  const left = validateCasimirManagementOwner(leftValue);
  const right = validateCasimirManagementOwner(rightValue);
  return canonicalManagementJson(left) === canonicalManagementJson(right);
}

export async function readCasimirManagementOwner(state: string): Promise<CasimirManagementOwner> {
  return validateCasimirManagementOwner(
    await readPrivate(join(state, OWNER_FILENAME), MAX_CONFIG_BYTES),
  );
}

/** Creates or verifies the root-owned authority using the current ready receipt. */
export async function prepareCasimirManagementOwner(
  state: string,
  identity: InstallIdentity,
  lockHeld = false,
): Promise<CasimirManagementOwner> {
  const prepare = async () => {
    await privateState(state);
    const receipt = await readPrivate(join(state, 'receipt.json')) as {
      format?: number;
      installationId?: string;
      operatorId?: string;
      projectId?: string;
      bundleVersion?: string;
      bundleHash?: string;
      phase?: string;
    };
    if (
      receipt.format !== 1 ||
      receipt.installationId !== identity.installationId ||
      receipt.bundleVersion !== identity.bundleVersion ||
      receipt.bundleHash !== identity.bundleHash ||
      receipt.phase !== 'ready' ||
      typeof receipt.operatorId !== 'string' || !/^user_[a-z0-9]{12}$/.test(receipt.operatorId) ||
      typeof receipt.projectId !== 'string' || !/^proj_[a-z0-9]{12}$/.test(receipt.projectId)
    ) {
      throw new Error('management_receipt_identity');
    }
    const path = join(state, OWNER_FILENAME);
    try {
      const existing = await readCasimirManagementOwner(state);
      if (
        existing.installationId !== identity.installationId ||
        existing.operatorId !== receipt.operatorId ||
        existing.projectId !== receipt.projectId
      ) {
        throw new Error('management_owner_conflict');
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const projectKey = randomBytes(32);
    const owner = validateCasimirManagementOwner({
      format: 1,
      installationId: identity.installationId,
      ownershipNonce: randomBytes(32).toString('hex'),
      jwtSecret: generateManagedAuthSecret(),
      authSetupToken: generateManagedAuthSecret(),
      projectSecretKeysJson: JSON.stringify({ '1': projectKey.toString('base64') }),
      projectSecretActiveKeyVersion: '1',
      operatorId: receipt.operatorId,
      projectId: receipt.projectId,
    });
    if (
      owner.jwtSecret === identity.token ||
      owner.authSetupToken === identity.token ||
      owner.ownershipNonce === identity.token
    ) {
      throw new Error('management_secret_reuse');
    }
    await atomicPrivateJson(path, owner, MAX_CONFIG_BYTES);
    return owner;
  };
  return lockHeld ? prepare() : withStateLock(state, prepare);
}

async function readPrivateConfig(path: string, expectedUid: number): Promise<CasimirManagementConfig> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== expectedUid) {
      throw new Error('management_configuration_permissions');
    }
    if (metadata.size > MAX_CONFIG_BYTES) throw new Error('management_configuration_size');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error('management_configuration_size');
    return validateCasimirManagementConfig(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await file.close();
  }
}

/** Reads the API-only key file with exact owner, mode and no-follow checks. */
export async function readCasimirManagementConfig(
  path: string,
  expectedUid = process.getuid?.(),
): Promise<CasimirManagementConfig> {
  if (!Number.isSafeInteger(expectedUid) || expectedUid! < 0) {
    throw new Error('management_configuration_owner_invalid');
  }
  return readPrivateConfig(path, expectedUid!);
}

/** Publishes or resumes only the exact canonical API file under the state lock. */
export async function publishCasimirManagementConfig(
  state: string,
  input: CasimirManagementConfig,
  lockHeld = false,
): Promise<void> {
  const config = validateCasimirManagementConfig(input);
  const publish = async () => {
    await privateState(state);
    const owner = await readCasimirManagementOwner(state);
    if (!managementOwnerMatches(owner, config)) throw new Error('management_configuration_conflict');
    const path = join(state, API_FILENAME);
    const apiUid = 1000;
    try {
      const existing = await readPrivateConfig(path, apiUid);
      if (canonicalManagementJson(existing) !== canonicalManagementJson(config)) {
        throw new Error('management_configuration_conflict');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (process.getuid?.() !== 0 && process.getuid?.() !== apiUid) {
          throw new Error('management_api_owner_unavailable');
        }
        await atomicPrivateJson(
          path,
          config,
          MAX_CONFIG_BYTES,
          process.getuid?.() === 0 ? { uid: apiUid, gid: apiUid } : undefined,
        );
        return;
      }
      if (
        process.getuid?.() === 0 &&
        error instanceof Error &&
        error.message === 'management_configuration_permissions'
      ) {
        let pending: CasimirManagementConfig;
        try {
          pending = await readPrivateConfig(path, 0);
        } catch {
          throw new Error('management_configuration_conflict');
        }
        if (canonicalManagementJson(pending) !== canonicalManagementJson(config)) {
          throw new Error('management_configuration_conflict');
        }
        await chown(path, apiUid, apiUid);
        const repaired = await readPrivateConfig(path, apiUid);
        if (canonicalManagementJson(repaired) !== canonicalManagementJson(config)) {
          throw new Error('management_configuration_conflict');
        }
        return;
      }
      throw error;
    }
  };
  if (lockHeld) await publish();
  else await withStateLock(state, publish);
}

/** Atomically replaces the API reader's copy after the owner record changes under the same state lock. */
export async function replaceCasimirManagementConfig(
  state: string,
  input: CasimirManagementConfig,
  lockHeld = false,
): Promise<void> {
  const config = validateCasimirManagementConfig(input);
  const replace = async () => {
    await privateState(state);
    const owner = await readCasimirManagementOwner(state);
    if (!managementOwnerMatches(owner, config)) throw new Error('management_configuration_conflict');
    await atomicPrivateJson(
      join(state, API_FILENAME),
      config,
      MAX_CONFIG_BYTES,
      process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : undefined,
    );
  };
  if (lockHeld) await replace();
  else await withStateLock(state, replace);
}
