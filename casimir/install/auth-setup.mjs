import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chown, lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isCanonicalAbsolutePath, parseAuthSetupArguments } from './auth-setup-arguments.mjs';
export { parseAuthSetupArguments } from './auth-setup-arguments.mjs';
import { prepareFileAuthentication, authenticationSetupRequestHash } from '../../packages/void/src/cli/platform-auth-input.ts';
import {
  initializePlatformAuthentication,
  resumePlatformAuthentication,
} from '../../packages/void/src/cli/platform-auth-core.ts';
import {
  atomicPrivateFile,
  atomicPrivateJson,
  readPrivate,
  withStateLock,
} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
import { parseInstallConfig } from '../../platform/packages/api/src/casimir/lifecycle/config.ts';
import { deriveResources } from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';
import { loadMvpProfile } from '../../platform/packages/api/src/casimir/mvp/profile.ts';
import { MvpEngine } from '../../platform/packages/api/src/casimir/mvp/engine.ts';
import {
  canonicalManagementJson,
  managementOwnerMatches,
  replaceCasimirManagementConfig,
  readCasimirManagementConfig,
  readCasimirManagementOwner,
  validateCasimirManagementOwner,
} from '../../platform/packages/api/src/casimir/management/management-files.ts';
import { parseIdentityPolicy } from '../../platform/packages/api/src/casimir/management/identity-policy.ts';
import { inspectControlIngressRequestTarget } from '../../platform/packages/api/src/casimir/lifecycle/ingress-readiness.ts';
import { assertInstallResourcesOwned, docker, enableIdentityEgressNetwork } from './install.mjs';
import { createAuthSetupFetch } from './auth-transport.mjs';
import {
  AUTH_SETUP_CHECKPOINT_MAX_BYTES,
  AUTH_SETUP_REQUEST_MAX_BYTES,
  managementKeyFingerprint,
  validateAuthSetupCheckpoint,
  validateManagementPolicyPair,
} from './management-checkpoint.mjs';

const MAX_INPUT_BYTES = AUTH_SETUP_REQUEST_MAX_BYTES;
const MAX_API_ENV_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = AUTH_SETUP_CHECKPOINT_MAX_BYTES;
const CHECKPOINT_FILE = 'auth-setup-checkpoint.json';
const API_CONFIG_FILE = 'management.json';
const OWNER_FILE = 'management-owner.json';
const CONFIG_BINDING = 'CASIMIR_MANAGEMENT_CONFIG=/config/management.json';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertPathOutsideState(path, state) {
  if (!isCanonicalAbsolutePath(path) || !isCanonicalAbsolutePath(state)) {
    throw fail('auth_setup_input_path');
  }
  const withinState = relative(state, path);
  if (
    withinState === '' ||
    (!isAbsolute(withinState) && withinState !== '..' && !withinState.startsWith(`..${sep}`))
  ) {
    throw fail('auth_setup_input_path');
  }
}

export async function readAuthSetupInputFile(path, state, maxBytes = MAX_INPUT_BYTES) {
  assertPathOutsideState(path, state);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('auth_setup_input_size');
  let before;
  try {
    before = await lstat(path);
  } catch {
    throw fail('auth_setup_input_file');
  }
  if (!before.isFile() || (before.mode & 0o777) !== 0o600 || await realpath(path) !== path) {
    throw fail('auth_setup_input_permissions');
  }
  if (before.size > maxBytes) throw fail('auth_setup_input_size');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      (current.mode & 0o777) !== 0o600 ||
      current.size > maxBytes
    ) {
      throw fail('auth_setup_input_permissions');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw fail('auth_setup_input_size');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } catch {
      throw fail('auth_setup_input_encoding');
    }
  } catch (error) {
    if (error?.code?.startsWith?.('auth_setup_')) throw error;
    throw fail('auth_setup_input_file');
  } finally {
    await file?.close();
  }
}

export function prepareCasimirAuthSetupInput({ authentication, secrets, identityPolicy, checkpoint = {} }) {
  if (!isRecord(authentication) || !Array.isArray(authentication.connections)) {
    throw fail('auth_setup_auth_file_invalid');
  }
  if (
    (Object.hasOwn(authentication, 'protection') && authentication.protection !== null) ||
    Object.hasOwn(authentication, 'cloudflareAccess') ||
    Object.hasOwn(authentication, 'appAccess')
  ) {
    throw fail('auth_setup_protection_unsupported');
  }
  if (
    authentication.connections.some(
      (connection) => connection?.configuration?.kind === 'cloudflare-access',
    )
  ) {
    throw fail('auth_setup_provider_unsupported');
  }

  let prepared;
  try {
    prepared = prepareFileAuthentication(authentication, secrets, checkpoint);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('platform:')) throw error;
    throw fail('auth_setup_input_invalid');
  }
  let setup;
  try {
    setup = JSON.parse(prepared.authenticationSetupJson);
  } catch {
    throw fail('auth_setup_input_invalid');
  }
  if (setup.connections.some((entry) => entry.configuration.kind === 'cloudflare-access')) {
    throw fail('auth_setup_provider_unsupported');
  }
  if (Buffer.byteLength(prepared.authenticationSetupJson, 'utf8') > MAX_INPUT_BYTES) {
    throw fail('auth_setup_request_size');
  }
  let parsedIdentityPolicy;
  if (identityPolicy !== undefined) {
    try {
      parsedIdentityPolicy = parseIdentityPolicy(identityPolicy);
    } catch {
      throw fail('auth_setup_identity_policy_invalid');
    }
  }
  return {
    ...prepared,
    ...(parsedIdentityPolicy ? { identityNetwork: parsedIdentityPolicy } : {}),
  };
}

async function readPrivateTextFile(path, maxBytes, expectedUid = process.getuid?.()) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.uid !== expectedUid ||
      metadata.size > maxBytes
    ) {
      throw fail('auth_setup_private_state_invalid');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw fail('auth_setup_private_state_invalid');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

async function assertPrivateStateDirectory(state) {
  if (!isCanonicalAbsolutePath(state)) throw fail('auth_setup_state_path');
  let metadata;
  try {
    metadata = await lstat(state);
  } catch {
    throw fail('auth_setup_state_invalid');
  }
  if (
    !metadata.isDirectory() ||
    await realpath(state) !== state ||
    (metadata.mode & 0o777) !== 0o700 ||
    metadata.uid !== process.getuid?.()
  ) {
    throw fail('auth_setup_state_invalid');
  }
}

function parsePrivateJson(text, code) {
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error('not_object');
    return value;
  } catch {
    throw fail(code);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function identityNetworkValue(owner) {
  return owner.identityNetwork ?? null;
}

function ownerWithoutIdentityNetwork(value) {
  const { identityNetwork: _identityNetwork, ...base } = value;
  return base;
}

function managementKeyGenerationMatches(left, right) {
  return canonicalManagementJson(ownerWithoutIdentityNetwork(left)) ===
    canonicalManagementJson(ownerWithoutIdentityNetwork(right));
}

function samePolicy(left, right) {
  if (left === null || right === null) return left === right;
  return canonicalManagementJson(left) === canonicalManagementJson(right);
}

function updateApiEnvironment(contents, state) {
  const encodedState = Buffer.from(state, 'utf8').toString('base64');
  const lines = contents.split(/\r?\n/);
  const collect = (key) => lines.filter((line) => line.startsWith(`${key}=`));
  const configEntries = collect('CASIMIR_MANAGEMENT_CONFIG');
  const activationEntries = collect('CASIMIR_MANAGEMENT_ENABLED');
  const stateEntries = collect('CASIMIR_AUTH_SETUP_STATE_B64');
  if (
    configEntries.length !== 1 || configEntries[0] !== CONFIG_BINDING ||
    activationEntries.length > 1 || stateEntries.length > 1 ||
    (activationEntries.length === 1 && !['CASIMIR_MANAGEMENT_ENABLED=true', 'CASIMIR_MANAGEMENT_ENABLED=false'].includes(activationEntries[0])) ||
    (stateEntries.length === 1 && stateEntries[0] !== `CASIMIR_AUTH_SETUP_STATE_B64=${encodedState}`)
  ) {
    throw fail('auth_setup_api_environment_conflict');
  }
  const output = lines.filter((line) =>
    !line.startsWith('CASIMIR_MANAGEMENT_ENABLED=') &&
    !line.startsWith('CASIMIR_AUTH_SETUP_STATE_B64='),
  );
  while (output.at(-1) === '') output.pop();
  output.push('CASIMIR_MANAGEMENT_ENABLED=true', `CASIMIR_AUTH_SETUP_STATE_B64=${encodedState}`);
  return `${output.join('\n')}\n`;
}

function assertManagementCompose(compose, state) {
  if (!isRecord(compose) || !isRecord(compose.services) || !isRecord(compose.services.api)) {
    throw fail('auth_setup_compose_invalid');
  }
  const mounts = compose.services.api.volumes;
  if (!Array.isArray(mounts)) throw fail('auth_setup_compose_invalid');
  const managementSource = join(state, API_CONFIG_FILE);
  const managementMounts = mounts.filter(
    (entry) => entry && typeof entry === 'object' &&
      (entry.source === managementSource || entry.target === '/config/management.json'),
  );
  if (
    managementMounts.length !== 1 ||
    managementMounts[0].type !== 'bind' ||
    managementMounts[0].source !== join(state, API_CONFIG_FILE) ||
    managementMounts[0].read_only !== true
  ) {
    throw fail('auth_setup_compose_invalid');
  }
  for (const [name, service] of Object.entries(compose.services)) {
    if (!isRecord(service) || (service.volumes !== undefined && !Array.isArray(service.volumes))) {
      throw fail('auth_setup_compose_invalid');
    }
    if (name === 'api') continue;
    if ((service.volumes ?? []).some((entry) =>
      entry && typeof entry === 'object' &&
      (entry.source === managementSource || entry.target === '/config/management.json')
    )) {
      throw fail('auth_setup_compose_invalid');
    }
  }
}

function validateReadyIdentity(identity, receipt, profile, config) {
  const expectedIdentityKeys = 'bundleHash,bundleVersion,config,databasePassword,format,installationId,token';
  const expectedReceiptKeys = 'bundleHash,bundleVersion,format,installationId,operatorId,phase,projectId,resources';
  if (
    Object.keys(identity).sort().join(',') !== expectedIdentityKeys ||
    identity.format !== 1 ||
    !/^[a-f0-9]{32}$/.test(identity.installationId) ||
    !/^[a-f0-9]{64}$/.test(identity.token) ||
    !/^[a-f0-9]{64}$/.test(identity.databasePassword) ||
    !/^c1\.\d+$/.test(identity.bundleVersion) ||
    !/^[a-f0-9]{64}$/.test(identity.bundleHash) ||
    Object.keys(receipt).sort().join(',') !== expectedReceiptKeys ||
    receipt.format !== 1 ||
    receipt.phase !== 'ready' ||
    receipt.installationId !== identity.installationId ||
    receipt.bundleVersion !== identity.bundleVersion ||
    receipt.bundleHash !== identity.bundleHash ||
    !/^user_[a-z0-9]{12}$/.test(receipt.operatorId) ||
    !/^proj_[a-z0-9]{12}$/.test(receipt.projectId) ||
    canonicalManagementJson(receipt.resources) !==
      canonicalManagementJson(deriveResources(identity.installationId)) ||
    profile.installationId !== identity.installationId ||
    profile.origins?.control !== config.controlOrigin ||
    profile.origins?.app !== config.appOrigin
  ) {
    throw fail('auth_setup_installation_not_ready');
  }
}

async function readCheckpoint(path) {
  try {
    return await readPrivate(path, MAX_CHECKPOINT_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw fail('auth_setup_checkpoint_invalid');
  }
}

async function readApiManagementConfig(path) {
  try {
    return { config: await readCasimirManagementConfig(path, 1000), uid: 1000 };
  } catch (error) {
    if (error?.message === 'management_configuration_permissions') {
      try {
        return { config: await readCasimirManagementConfig(path, 0), uid: 0 };
      } catch {
        throw fail('auth_setup_management_pair_conflict');
      }
    }
    throw fail('auth_setup_management_pair_conflict');
  }
}

async function updateManagementPolicyPair(
  state,
  owner,
  apiConfig,
  checkpoint,
  uid,
  replaceApiConfig = replaceCasimirManagementConfig,
) {
  const target = checkpoint.identityNetwork;
  const current = identityNetworkValue(owner);
  const nextOwner = validateCasimirManagementOwner({
    ...ownerWithoutIdentityNetwork(owner),
    ...(target ? { identityNetwork: target } : {}),
  });
  if (canonicalManagementJson(owner) !== canonicalManagementJson(nextOwner)) {
    await atomicPrivateJson(join(state, OWNER_FILE), nextOwner, 65_536);
  }

  const apiPath = join(state, API_CONFIG_FILE);
  const apiMatchesTarget = apiConfig && samePolicy(identityNetworkValue(apiConfig), target) &&
    canonicalManagementJson(apiConfig) === canonicalManagementJson(nextOwner);
  if (apiMatchesTarget && uid === 1000) return nextOwner;
  if (apiMatchesTarget && uid === 0) {
    await chown(apiPath, 1000, 1000);
    const repaired = await readCasimirManagementConfig(apiPath, 1000);
    if (!managementOwnerMatches(nextOwner, repaired)) throw fail('auth_setup_management_pair_conflict');
    return nextOwner;
  }
  if (
    !samePolicy(identityNetworkValue(apiConfig), checkpoint.previousIdentityNetwork) &&
    !samePolicy(identityNetworkValue(apiConfig), target)
  ) {
    throw fail('auth_setup_management_pair_conflict');
  }
  await replaceApiConfig(state, nextOwner, true);
  const published = await readCasimirManagementConfig(apiPath, 1000);
  if (!managementOwnerMatches(nextOwner, published)) throw fail('auth_setup_management_pair_conflict');
  return nextOwner;
}

function validateInputHashes(checkpoint, snapshot) {
  if (!snapshot) return;
  if (
    checkpoint.authConfigHash !== snapshot.authConfigHash ||
    checkpoint.authSecretsHash !== snapshot.authSecretsHash ||
    (snapshot.identityPolicyHash !== null && checkpoint.identityPolicyHash !== snapshot.identityPolicyHash) ||
    (snapshot.identityPolicyHash === null && checkpoint.identityPolicyHash !== null && snapshot.identityPolicyProvided)
  ) {
    throw fail('auth_setup_checkpoint_conflict');
  }
}

async function loadInputSnapshot(state, inputs) {
  const hasAuthConfig = Boolean(inputs.authConfigPath);
  if (hasAuthConfig !== Boolean(inputs.authSecretsPath) || (inputs.identityPolicyPath && !hasAuthConfig)) {
    throw fail('auth_setup_usage');
  }
  if (!hasAuthConfig) return null;
  const authConfigText = await readAuthSetupInputFile(inputs.authConfigPath, state, MAX_INPUT_BYTES);
  const authSecretsText = await readAuthSetupInputFile(inputs.authSecretsPath, state, MAX_INPUT_BYTES);
  const authentication = parsePrivateJson(authConfigText, 'auth_setup_auth_file_invalid');
  const secrets = parsePrivateJson(authSecretsText, 'auth_setup_secrets_invalid');
  let identityPolicy;
  let identityPolicyHash = null;
  if (inputs.identityPolicyPath) {
    const policyText = await readAuthSetupInputFile(inputs.identityPolicyPath, state, 32 * 1024);
    identityPolicy = parsePrivateJson(policyText, 'auth_setup_identity_policy_invalid');
    identityPolicyHash = sha256(policyText);
  }
  const authConfigHash = sha256(authConfigText);
  const authSecretsHash = sha256(authSecretsText);
  // Validate the full, bounded input before taking the lifecycle lock or writing state.
  const validated = prepareCasimirAuthSetupInput({ authentication, secrets, identityPolicy });
  return {
    authentication,
    secrets,
    identityPolicy,
    identityPolicyProvided: Boolean(inputs.identityPolicyPath),
    authConfigHash,
    authSecretsHash,
    identityPolicyHash,
    validated,
  };
}

async function readInstallationState(state) {
  const identity = await readPrivate(join(state, 'identity.json'));
  const receipt = await readPrivate(join(state, 'receipt.json'));
  const config = parseInstallConfig(identity.config);
  const profilePath = join(state, 'profile.json');
  await readPrivateTextFile(profilePath, 65_536, 1000);
  const profile = loadMvpProfile(profilePath);
  validateReadyIdentity(identity, receipt, profile, config);
  const owner = await readCasimirManagementOwner(state);
  if (
    owner.installationId !== identity.installationId ||
    owner.operatorId !== receipt.operatorId ||
    owner.projectId !== receipt.projectId ||
    owner.jwtSecret === identity.token || owner.authSetupToken === identity.token || owner.ownershipNonce === identity.token
  ) {
    throw fail('auth_setup_management_pair_conflict');
  }
  let checkpoint = await readCheckpoint(join(state, CHECKPOINT_FILE));
  if (checkpoint) checkpoint = validateAuthSetupCheckpoint(checkpoint, owner, identity);
  const api = await readApiManagementConfig(join(state, API_CONFIG_FILE));
  if (api.config && (
    api.config.installationId !== identity.installationId ||
    api.config.operatorId !== receipt.operatorId ||
    api.config.projectId !== receipt.projectId
  )) {
    throw fail('auth_setup_management_pair_conflict');
  }
  try {
    validateManagementPolicyPair(owner, api.config, checkpoint);
  } catch {
    throw fail('auth_setup_management_pair_conflict');
  }

  if (
    config.mode === 'loopback' ||
    new URL(config.controlOrigin).protocol !== 'https:' ||
    canonicalHostname(config.controlOrigin) === canonicalHostname(config.appOrigin)
  ) {
    throw fail('auth_setup_requires_distinct_https_origins');
  }
  if (
    profile.origins?.control !== config.controlOrigin ||
    profile.origins?.app !== config.appOrigin ||
    profile.installationId !== identity.installationId
  ) {
    throw fail('auth_setup_installation_not_ready');
  }
  const compose = await readPrivate(join(state, 'compose.json'));
  assertManagementCompose(compose, state);
  const apiEnvPath = join(state, 'api.env');
  const apiEnv = await readPrivateTextFile(apiEnvPath, MAX_API_ENV_BYTES);
  if (!apiEnv.split(/\r?\n/).includes(CONFIG_BINDING)) throw fail('auth_setup_api_environment_conflict');
  const runner = parsePrivateJson(
    await readPrivateTextFile(join(state, 'runner.json'), 65_536, 1000),
    'auth_setup_installation_not_ready',
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(runner.imageId) || !runner.runtime) {
    throw fail('auth_setup_installation_not_ready');
  }
  return { identity, receipt, config, profile, owner, checkpoint, api, compose, apiEnv, runner };
}

function canonicalHostname(origin) {
  let hostname = new URL(origin).hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function createCheckpoint(snapshot, prepared, owner, identity, previousIdentityNetwork) {
  return {
    format: 1,
    installationId: identity.installationId,
    keyFingerprint: managementKeyFingerprint(owner),
    authConfigHash: snapshot.authConfigHash,
    authSecretsHash: snapshot.authSecretsHash,
    identityPolicyHash: snapshot.identityPolicyHash,
    identityNetwork: prepared.identityNetwork ?? previousIdentityNetwork,
    previousIdentityNetwork,
    authenticationSetupJson: prepared.authenticationSetupJson,
    authBootstrapCode: prepared.authBootstrapCode,
    requestHash: authenticationSetupRequestHash(prepared.authenticationSetupJson),
  };
}

export async function authSetup(state, inputs = {}, dependencies = {}) {
  if (process.getuid?.() !== 0) throw fail('auth_setup_root_required');
  await assertPrivateStateDirectory(state);
  const snapshot = await loadInputSnapshot(state, inputs);
  const runDocker = dependencies.docker ?? docker;
  const assertOwned = dependencies.assertInstallResourcesOwned ?? assertInstallResourcesOwned;
  const createFetch = dependencies.createAuthSetupFetch ?? createAuthSetupFetch;
  const inspectIngress = dependencies.inspectControlIngressRequestTarget ?? inspectControlIngressRequestTarget;
  const persistCheckpoint = dependencies.persistCheckpoint ??
    ((path, value) => atomicPrivateJson(path, value, MAX_CHECKPOINT_BYTES));
  const replaceApiConfig = dependencies.replaceCasimirManagementConfig ?? replaceCasimirManagementConfig;

  return withStateLock(state, async () => {
    const context = await readInstallationState(state);
    const { identity, receipt, config, profile, owner, compose, apiEnv, runner } = context;
    enableIdentityEgressNetwork(compose, identity.installationId);
    let checkpoint = context.checkpoint;
    let prepared;
    if (checkpoint) {
      validateInputHashes(checkpoint, snapshot);
      if (snapshot) {
        prepared = prepareCasimirAuthSetupInput({
          authentication: snapshot.authentication,
          secrets: snapshot.secrets,
          identityPolicy: snapshot.identityPolicy,
          checkpoint: {
            authenticationSetupJson: checkpoint.authenticationSetupJson,
            authBootstrapCode: checkpoint.authBootstrapCode,
            authSetupToken: owner.authSetupToken,
          },
        });
        if (
          prepared.authBootstrapCode !== checkpoint.authBootstrapCode ||
          authenticationSetupRequestHash(prepared.authenticationSetupJson) !== checkpoint.requestHash
        ) {
          throw fail('auth_setup_checkpoint_conflict');
        }
      }
    } else {
      if (!snapshot) throw fail('auth_setup_checkpoint_missing');
      prepared = prepareCasimirAuthSetupInput({
        authentication: snapshot.authentication,
        secrets: snapshot.secrets,
        identityPolicy: snapshot.identityPolicy,
        checkpoint: { authSetupToken: owner.authSetupToken },
      });
      checkpoint = createCheckpoint(
        snapshot,
        prepared,
        owner,
        identity,
        identityNetworkValue(owner),
      );
    }
    if (!checkpoint) throw fail('auth_setup_checkpoint_missing');
    checkpoint = validateAuthSetupCheckpoint(checkpoint, owner, identity);
    // Validate ownership and the exact TLS ingress destination before the first state write.
    assertOwned(identity.installationId, config, runDocker);
    const engine = new MvpEngine({
      socketPath: '/var/run/docker.sock',
      runnerImage: runner.imageId,
      runtime: profile.runtime,
      installationId: identity.installationId,
      appOrigin: profile.origins.app,
    });
    const ca = Buffer.from(await readPrivateTextFile(join(state, 'tls-ca.pem'), 16 * 1024, 1000), 'utf8');
    const target = await inspectIngress(
      engine,
      config.controlOrigin,
      ca,
      profile.externalTls,
    );
    const fetcher = await createFetch({
      engine,
      controlOrigin: config.controlOrigin,
      ca,
      externalTls: profile.externalTls,
      target,
    });

    const checkpointPath = join(state, CHECKPOINT_FILE);
    if (!context.checkpoint) await persistCheckpoint(checkpointPath, checkpoint);
    await atomicPrivateJson(join(state, 'compose.json'), compose);
    const updatedOwner = await updateManagementPolicyPair(
      state,
      owner,
      context.api.config,
      checkpoint,
      context.api.uid,
      replaceApiConfig,
    );
    const nextApiEnv = updateApiEnvironment(apiEnv, state);
    if (nextApiEnv !== apiEnv) await atomicPrivateFile(join(state, 'api.env'), nextApiEnv, MAX_API_ENV_BYTES);

    // Revalidate immediately before recreating the API service; the Docker socket stays inside this trusted role.
    assertOwned(identity.installationId, config, runDocker);
    runDocker([
      'compose', '-f', join(state, 'compose.json'), 'up', '-d', '--no-deps',
      '--force-recreate', '--wait', 'api',
    ]);

    let current = checkpoint;
    const initialize = (apiUrl, installationId, setupToken, setupJson) =>
      initializePlatformAuthentication(apiUrl, installationId, setupToken, setupJson, fetcher);
    const result = await resumePlatformAuthentication({
      apiUrl: config.controlOrigin,
      installationId: identity.installationId,
      setupToken: updatedOwner.authSetupToken,
      setupJson: checkpoint.authenticationSetupJson,
      checkpoint: async (replacement) => {
        current = {
          ...current,
          authenticationSetupJson: replacement.authenticationSetupJson,
          authBootstrapCode: replacement.authBootstrapCode,
          requestHash: authenticationSetupRequestHash(replacement.authenticationSetupJson),
        };
        validateAuthSetupCheckpoint(current, updatedOwner, identity);
        await persistCheckpoint(checkpointPath, current);
      },
    }, initialize);
    if (!result.setupPending) {
      await rm(checkpointPath);
      await syncDirectory(state);
      return { status: 'complete', setupPending: false };
    }
    return {
      status: 'pending',
      setupPending: true,
      setupUrl: new URL('/setup', config.controlOrigin).href,
      expiresAt: result.expiresAt,
      authBootstrapCode: current.authBootstrapCode,
    };
  });
}
