import type { VoidConfig } from '../config.ts';

export function resolveCasimirProfile(config: VoidConfig): 'node-sqlite-v1' | null {
  if (config.casimir === undefined) {
    return null;
  }
  if (config.target !== 'node') {
    throw new Error('casimir: profile requires target: "node".');
  }
  const value = config.casimir;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'profile' ||
    value.profile !== 'node-sqlite-v1'
  ) {
    throw new Error('casimir: expected exactly profile: "node-sqlite-v1".');
  }
  if (config.database || config.remote || config.auth || config.output === 'static') {
    throw new Error(
      'casimir: external SQL, remote bindings, managed auth and static output are unsupported.',
    );
  }
  return 'node-sqlite-v1';
}
