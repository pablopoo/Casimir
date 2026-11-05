import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, join } from 'node:path';
import { readCasimirManagementConfig } from '../../platform/packages/api/src/casimir/management/management-files.ts';
import { readPrivate } from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
import {
  AUTH_SETUP_CHECKPOINT_MAX_BYTES,
  validateAuthSetupCheckpoint,
  validateManagementPolicyPair,
} from '../dist/managementCheckpoint.mjs';

const API_ENV_MAX_BYTES = 64 * 1024;
const CHECKPOINT_FILE = 'auth-setup-checkpoint.json';

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function fail(code) {
  throw new Error(code);
}

function canonicalAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\0\r\n,]/.test(value) &&
    isAbsolute(value) && normalize(value) === value && resolve(value) === value;
}

async function readPrivateText(path, expectedUid, maxBytes, code) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== expectedUid || (info.mode & 0o777) !== 0o600) fail(code);
    if (info.size > maxBytes) fail(environmentSizeCode(code));
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) fail(environmentSizeCode(code));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof Error && /^(?:management_|restore_management_)/.test(error.message)) throw error;
    throw new Error(code);
  } finally {
    await file.close();
  }
}

function environmentSizeCode(permissionsCode) {
  return permissionsCode === 'restore_management_config_permissions'
    ? 'restore_management_api_environment_size'
    : 'management_api_environment_size';
}

function parseApiEnvironment(text, code) {
  const lines = text.split(/\r?\n/);
  const values = new Map();
  for (const key of ['CASIMIR_MANAGEMENT_CONFIG', 'CASIMIR_MANAGEMENT_ENABLED', 'CASIMIR_AUTH_SETUP_STATE_B64']) {
    const entries = lines.filter((line) => line.startsWith(`${key}=`));
    if (entries.length > 1) fail(code);
    values.set(key, entries.length ? entries[0].slice(key.length + 1) : null);
  }
  return values;
}

function decodeStatePath(encoded, code) {
  if (encoded === null) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail(code);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail(code);
  let path;
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  if (!canonicalAbsolutePath(path)) fail(code);
  return path;
}

async function inspectManagementState(stateDir, identity, receipt, {
  restored = false,
  expectedOperationalStatePath = stateDir,
} = {}) {
  if (!canonicalAbsolutePath(stateDir) || await realpath(stateDir) !== stateDir) {
    fail(restored ? 'restore_management_config_path' : 'management_state_path');
  }
  if (!restored && !canonicalAbsolutePath(expectedOperationalStatePath)) {
    fail('management_auth_setup_state_path');
  }
  const stateInfo = await lstat(stateDir);
  const permissionsCode = restored
    ? 'restore_management_config_permissions'
    : 'management_state_permissions';
  if (!stateInfo.isDirectory() || (stateInfo.mode & 0o777) !== 0o700) fail(permissionsCode);

  const ownerPath = join(stateDir, 'management-owner.json');
  const configPath = join(stateDir, 'management.json');
  const checkpointPath = join(stateDir, CHECKPOINT_FILE);
  const apiEnvPath = join(stateDir, 'api.env');
  const [ownerPresent, configPresent, checkpointPresent] = await Promise.all([
    exists(ownerPath), exists(configPath), exists(checkpointPath),
  ]);
  if (ownerPresent !== configPresent) fail(restored ? 'restore_management_config_pair' : 'management_configuration_pair');

  const apiEnv = await readPrivateText(apiEnvPath, stateInfo.uid, API_ENV_MAX_BYTES, permissionsCode);
  const values = parseApiEnvironment(apiEnv, restored ? 'restore_management_config_identity' : 'management_api_environment');
  const configValue = values.get('CASIMIR_MANAGEMENT_CONFIG');
  const marker = values.get('CASIMIR_MANAGEMENT_ENABLED');
  const encodedPath = values.get('CASIMIR_AUTH_SETUP_STATE_B64');
  if (marker !== null && marker !== 'true' && marker !== 'false') {
    fail(restored ? 'restore_management_activation' : 'management_activation');
  }
  const managementEnabled = marker === 'true';
  const authSetupStatePath = decodeStatePath(encodedPath, restored
    ? 'restore_auth_setup_state_path'
    : 'management_auth_setup_state_path');

  if (!ownerPresent) {
    if (configValue !== null || managementEnabled || authSetupStatePath !== null || checkpointPresent) {
      fail(restored ? 'restore_management_config_pair' : 'management_configuration_pair');
    }
    return { managementConfig: false, managementEnabled: false, authSetupStatePath: null, checkpointPath: null };
  }
  if (configValue !== '/config/management.json') {
    fail(restored ? 'restore_management_config_identity' : 'management_api_environment');
  }
  if ((managementEnabled || checkpointPresent) && !authSetupStatePath) {
    fail(restored ? 'restore_auth_setup_state_path' : 'management_auth_setup_state_path');
  }
  if (!managementEnabled && (authSetupStatePath !== null || checkpointPresent)) {
    fail(restored ? 'restore_management_activation' : 'management_activation');
  }
  if (!restored && authSetupStatePath !== null && authSetupStatePath !== expectedOperationalStatePath) {
    fail('management_auth_setup_state_path');
  }

  const configUid = restored ? stateInfo.uid : 1000;
  const [owner, config] = await Promise.all([
    readCasimirManagementConfig(ownerPath, stateInfo.uid),
    readCasimirManagementConfig(configPath, configUid),
  ]);
  if (
    owner.installationId !== identity.installationId ||
    owner.installationId !== receipt.installationId ||
    owner.operatorId !== receipt.operatorId ||
    owner.projectId !== receipt.projectId ||
    owner.jwtSecret === identity.token ||
    owner.authSetupToken === identity.token ||
    owner.ownershipNonce === identity.token
  ) {
    fail(restored ? 'restore_management_config_identity' : 'management_configuration_conflict');
  }

  let checkpoint = null;
  if (checkpointPresent) {
    try {
      checkpoint = await readPrivate(checkpointPath, AUTH_SETUP_CHECKPOINT_MAX_BYTES);
    } catch {
      fail(restored ? 'restore_auth_setup_checkpoint_invalid' : 'management_auth_setup_checkpoint_invalid');
    }
    try {
      checkpoint = validateAuthSetupCheckpoint(checkpoint, owner, identity);
      validateManagementPolicyPair(owner, config, checkpoint);
    } catch {
      fail(restored ? 'restore_auth_setup_checkpoint_conflict' : 'management_auth_setup_checkpoint_conflict');
    }
  } else {
    try {
      validateManagementPolicyPair(owner, config, null);
    } catch {
      fail(restored ? 'restore_management_config_identity' : 'management_configuration_conflict');
    }
  }

  return {
    managementConfig: true,
    managementEnabled,
    authSetupStatePath,
    checkpointPath: checkpointPresent ? checkpointPath : null,
  };
}

/** Validates the optional owner/API pair and pending setup checkpoint before capture or maintenance. */
export async function inspectManagementStatePair(stateDir, identity, receipt, expectedOperationalStatePath = stateDir) {
  const result = await inspectManagementState(stateDir, identity, receipt, { expectedOperationalStatePath });
  if (!result.managementConfig) return null;
  return {
    ownerPath: join(stateDir, 'management-owner.json'),
    configPath: join(stateDir, 'management.json'),
    ...(result.checkpointPath ? { checkpointPath: result.checkpointPath } : {}),
  };
}

/** Returns validated restore state; config-file presence alone never activates management. */
export async function inspectRestoredManagementState(stateDir, identity, receipt) {
  return inspectManagementState(stateDir, identity, receipt, { restored: true });
}

/** Backward-compatible boolean API retained for existing callers. */
export async function inspectRestoredManagementStatePair(stateDir, identity, receipt) {
  return (await inspectRestoredManagementState(stateDir, identity, receipt)).managementConfig;
}

export function rewriteAuthSetupStatePath(contents, targetStateDir) {
  if (typeof contents !== 'string' || !canonicalAbsolutePath(targetStateDir)) {
    throw new Error('restore_auth_setup_state_path');
  }
  const lines = contents.split(/(\r\n|\n)/);
  const records = lines.filter((_part, index) => index % 2 === 0);
  const markers = records.filter((line) => line.startsWith('CASIMIR_MANAGEMENT_ENABLED='));
  const paths = records.filter((line) => line.startsWith('CASIMIR_AUTH_SETUP_STATE_B64='));
  if (
    markers.length !== 1 || markers[0] !== 'CASIMIR_MANAGEMENT_ENABLED=true' ||
    paths.length !== 1
  ) {
    throw new Error('restore_auth_setup_state_path');
  }
  const sourcePath = decodeStatePath(paths[0].slice('CASIMIR_AUTH_SETUP_STATE_B64='.length), 'restore_auth_setup_state_path');
  if (!sourcePath) throw new Error('restore_auth_setup_state_path');
  const encodedTarget = Buffer.from(targetStateDir, 'utf8').toString('base64');
  const lineIndex = lines.findIndex((part, index) => index % 2 === 0 && part.startsWith('CASIMIR_AUTH_SETUP_STATE_B64='));
  if (lineIndex < 0 || lines.findIndex((part, index) => index > lineIndex && index % 2 === 0 && part.startsWith('CASIMIR_AUTH_SETUP_STATE_B64=')) >= 0) {
    throw new Error('restore_auth_setup_state_path');
  }
  lines[lineIndex] = `CASIMIR_AUTH_SETUP_STATE_B64=${encodedTarget}`;
  return lines.join('');
}
