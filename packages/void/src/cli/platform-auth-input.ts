import { createHash, randomBytes } from 'node:crypto';
import {
  parsePlatformAccessProtection,
  parsePlatformAdmissionPolicy,
  parsePlatformAuthenticationSetup,
  parsePlatformLoginConfiguration,
  type PlatformAuthenticationSetup,
} from '@void/platform';

export type PlatformAuthenticationCheckpoint = Readonly<{
  authenticationSetupJson?: string;
  authBootstrapCode?: string;
  authSetupToken?: string;
}>;

export type PreparedPlatformAuthentication = Readonly<{
  authenticationSetupJson: string;
  authBootstrapCode: string;
  authSetupToken: string;
}>;

type AuthenticationSetupInput = Readonly<{
  admission: unknown;
  administratorConnectionId: string;
  checkpoint?: PlatformAuthenticationCheckpoint;
  connections: ReadonlyArray<PlatformAuthenticationSetup['connections'][number]>;
  protection: unknown;
  resetIfChanged?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSecretName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Shared setup construction for the interactive installer and private-file operator input. */
export function prepareAuthenticationSetup(
  input: AuthenticationSetupInput,
): PreparedPlatformAuthentication {
  const checkpoint = input.checkpoint ?? {};
  let authBootstrapCode = checkpoint.authBootstrapCode || randomBytes(32).toString('hex');
  const authSetupToken = checkpoint.authSetupToken || randomBytes(32).toString('hex');
  let setup = parsePlatformAuthenticationSetup({
    connections: input.connections,
    administratorConnectionId: input.administratorConnectionId,
    admission: parsePlatformAdmissionPolicy(input.admission),
    protection: parsePlatformAccessProtection(input.protection),
    bootstrapCredentialHash: createHash('sha256').update(authBootstrapCode).digest('hex'),
  });
  if (input.resetIfChanged && checkpoint.authenticationSetupJson) {
    const previous = parsePlatformAuthenticationSetup(
      JSON.parse(checkpoint.authenticationSetupJson),
    );
    if (JSON.stringify({ ...previous, resetPending: undefined }) !== JSON.stringify(setup)) {
      authBootstrapCode = randomBytes(32).toString('hex');
      setup = parsePlatformAuthenticationSetup({
        ...setup,
        resetPending: true,
        bootstrapCredentialHash: createHash('sha256').update(authBootstrapCode).digest('hex'),
      });
    }
  }
  return {
    authenticationSetupJson: JSON.stringify(setup),
    authBootstrapCode,
    authSetupToken,
  };
}

/**
 * Prepare only the authentication subset of an AuthFile using explicitly
 * referenced secrets. This does not enact Cloudflare Access or application
 * provisioning settings; those fields are rejected rather than silently lost.
 */
export function prepareFileAuthentication(
  file: unknown,
  secrets: Readonly<Record<string, string>>,
  checkpoint: PlatformAuthenticationCheckpoint = {},
): PreparedPlatformAuthentication {
  if (
    !isRecord(file) ||
    !Array.isArray(file.connections) ||
    file.connections.length === 0 ||
    file.connections.length > 32
  ) {
    throw new Error('platform: Authentication file must define between 1 and 32 connections.');
  }
  if (Object.prototype.hasOwnProperty.call(file, 'cloudflareAccess')) {
    throw new Error('platform: cloudflareAccess is not supported by authentication-only input.');
  }
  if (Object.prototype.hasOwnProperty.call(file, 'appAccess')) {
    throw new Error('platform: appAccess is not supported by authentication-only input.');
  }
  if (!isRecord(secrets)) {
    throw new Error('platform: The private authentication secrets must be a JSON object.');
  }
  const suppliedNames = Object.keys(secrets);
  if (suppliedNames.some((name) => !isSecretName(name))) {
    throw new Error('platform: Invalid name in the private authentication secrets map.');
  }

  const referencedNames = new Set<string>();
  const connections = file.connections.map((value) => {
    if (!isRecord(value) || !isRecord(value.configuration)) {
      throw new Error('platform: Each authentication connection needs a configuration object.');
    }
    if (value.clientSecret !== undefined || value.configuration.clientSecret !== undefined) {
      throw new Error(
        'platform: Plaintext client secrets are not accepted in the authentication file.',
      );
    }
    if (typeof value.clientSecretEnv !== 'string' || !isSecretName(value.clientSecretEnv)) {
      throw new Error(
        'platform: Each authentication connection needs a valid clientSecretEnv reference.',
      );
    }
    const secretName = value.clientSecretEnv;
    referencedNames.add(secretName);
    if (!Object.prototype.hasOwnProperty.call(secrets, secretName)) {
      throw new Error(
        'platform: The private authentication secrets map is missing a referenced secret.',
      );
    }
    const clientSecret = secrets[secretName];
    if (typeof clientSecret !== 'string') {
      throw new Error('platform: Every private authentication secret must be a string.');
    }
    return {
      configuration: parsePlatformLoginConfiguration(value.configuration),
      clientSecret,
    };
  });

  if (suppliedNames.some((name) => !referencedNames.has(name))) {
    throw new Error('platform: The private authentication secrets map contains unused entries.');
  }

  const protection = parsePlatformAccessProtection(file.protection ?? null);
  const admission =
    file.admission ??
    (protection ? { mode: 'company', access: true, connections: [] } : { mode: 'restricted' });
  const administratorConnectionId = file.administratorConnectionId;
  if (administratorConnectionId !== undefined && administratorConnectionId !== null) {
    if (typeof administratorConnectionId !== 'string') {
      throw new Error('platform: administratorConnectionId must be a string when provided.');
    }
  }

  return prepareAuthenticationSetup({
    connections,
    administratorConnectionId: administratorConnectionId ?? connections[0]!.configuration.id,
    admission,
    protection,
    checkpoint,
    resetIfChanged: true,
  });
}

/** The platform request hash excludes a pending-setup reset marker. */
export function authenticationSetupRequestHash(setupJson: string): string {
  const { resetPending: _, ...configuration } = parsePlatformAuthenticationSetup(
    JSON.parse(setupJson),
  );
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}
