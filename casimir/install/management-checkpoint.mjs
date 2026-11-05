import { createHash } from 'node:crypto';
import { authenticationSetupRequestHash } from '../../packages/void/src/cli/platform-auth-input.ts';
import {
  canonicalManagementJson,
  managementOwnerMatches,
} from '../../platform/packages/api/src/casimir/management/management-files.ts';
import { parseIdentityPolicy } from '../../platform/packages/api/src/casimir/management/identity-policy.ts';

export const AUTH_SETUP_REQUEST_MAX_BYTES = 256 * 1024;
export const AUTH_SETUP_CHECKPOINT_MAX_BYTES = 1024 * 1024;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function managementKeyFingerprint(owner) {
  return sha256(canonicalManagementJson({
    format: owner.format,
    installationId: owner.installationId,
    ownershipNonce: owner.ownershipNonce,
    jwtSecret: owner.jwtSecret,
    authSetupToken: owner.authSetupToken,
    projectSecretKeysJson: owner.projectSecretKeysJson,
    projectSecretActiveKeyVersion: owner.projectSecretActiveKeyVersion,
    operatorId: owner.operatorId,
    projectId: owner.projectId,
  }));
}

export function validateAuthSetupCheckpoint(value, owner, identity) {
  const expectedKeys = [
    'authBootstrapCode',
    'authConfigHash',
    'authSecretsHash',
    'authenticationSetupJson',
    'format',
    'identityNetwork',
    'identityPolicyHash',
    'installationId',
    'keyFingerprint',
    'previousIdentityNetwork',
    'requestHash',
  ].sort();
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== expectedKeys.join(',') ||
    value.format !== 1 ||
    value.installationId !== identity.installationId ||
    value.keyFingerprint !== managementKeyFingerprint(owner) ||
    !/^[a-f0-9]{64}$/.test(value.authConfigHash) ||
    !/^[a-f0-9]{64}$/.test(value.authSecretsHash) ||
    (value.identityPolicyHash !== null && !/^[a-f0-9]{64}$/.test(value.identityPolicyHash)) ||
    !/^[a-f0-9]{64}$/.test(value.requestHash) ||
    !/^[a-f0-9]{64}$/.test(value.authBootstrapCode) ||
    typeof value.authenticationSetupJson !== 'string' ||
    Buffer.byteLength(value.authenticationSetupJson, 'utf8') > AUTH_SETUP_REQUEST_MAX_BYTES
  ) {
    fail('auth_setup_checkpoint_conflict');
  }
  let identityNetwork;
  let previousIdentityNetwork;
  try {
    identityNetwork = value.identityNetwork === null ? null : parseIdentityPolicy(value.identityNetwork);
    previousIdentityNetwork = value.previousIdentityNetwork === null
      ? null
      : parseIdentityPolicy(value.previousIdentityNetwork);
  } catch {
    fail('auth_setup_checkpoint_conflict');
  }
  try {
    const setup = JSON.parse(value.authenticationSetupJson);
    if (
      authenticationSetupRequestHash(value.authenticationSetupJson) !== value.requestHash ||
      setup.bootstrapCredentialHash !== sha256(value.authBootstrapCode)
    ) {
      fail('auth_setup_checkpoint_conflict');
    }
  } catch {
    fail('auth_setup_checkpoint_conflict');
  }
  return { ...value, identityNetwork, previousIdentityNetwork };
}

function samePolicy(left, right) {
  if (left === null || right === null) return left === right;
  return canonicalManagementJson(left) === canonicalManagementJson(right);
}

function identityNetworkValue(owner) {
  return owner.identityNetwork ?? null;
}

/** Allows only the three documented owner/API states around a pending policy update. */
export function validateManagementPolicyPair(owner, apiConfig, checkpoint) {
  if (!apiConfig) fail('management_configuration_conflict');
  const { identityNetwork: _ownerNetwork, ...ownerBase } = owner;
  const { identityNetwork: _apiNetwork, ...apiBase } = apiConfig;
  if (!managementOwnerMatches(ownerBase, apiBase)) fail('management_configuration_conflict');
  if (!checkpoint) {
    if (!managementOwnerMatches(owner, apiConfig)) fail('management_configuration_conflict');
    return;
  }
  const before = checkpoint.previousIdentityNetwork;
  const target = checkpoint.identityNetwork;
  const ownerNetwork = identityNetworkValue(owner);
  const apiNetwork = identityNetworkValue(apiConfig);
  const allowed =
    (samePolicy(ownerNetwork, before) && samePolicy(apiNetwork, before)) ||
    (samePolicy(ownerNetwork, target) && samePolicy(apiNetwork, before)) ||
    (samePolicy(ownerNetwork, target) && samePolicy(apiNetwork, target));
  if (!allowed) fail('management_configuration_conflict');
}
