import { isAbsolute, normalize, resolve } from 'node:path';

export function isCanonicalAbsolutePath(value) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value &&
    normalize(value) === value && !/[\0\r\n,]/.test(value);
}

export function parseAuthSetupArguments(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    const error = new Error('auth_setup_usage');
    error.code = 'auth_setup_usage';
    throw error;
  }
  if (args.length === 1 && args[0] === '--help') return { help: true };

  const values = new Map();
  const supported = new Set(['--state', '--auth-config', '--auth-secrets', '--identity-policy']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !supported.has(name) ||
      values.has(name) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.startsWith('--') ||
      !isCanonicalAbsolutePath(value)
    ) {
      const error = new Error('auth_setup_usage');
      error.code = 'auth_setup_usage';
      throw error;
    }
    values.set(name, value);
  }
  const state = values.get('--state');
  const authConfigPath = values.get('--auth-config');
  const authSecretsPath = values.get('--auth-secrets');
  const identityPolicyPath = values.get('--identity-policy');
  if (
    !state ||
    Boolean(authConfigPath) !== Boolean(authSecretsPath) ||
    (identityPolicyPath && !authConfigPath)
  ) {
    const error = new Error('auth_setup_usage');
    error.code = 'auth_setup_usage';
    throw error;
  }
  return {
    state,
    ...(authConfigPath ? { authConfigPath } : {}),
    ...(authSecretsPath ? { authSecretsPath } : {}),
    ...(identityPolicyPath ? { identityPolicyPath } : {}),
  };
}
