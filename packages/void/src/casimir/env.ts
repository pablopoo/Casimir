import { AsyncLocalStorage } from 'node:async_hooks';

export type RuntimeEnv = Record<string, unknown>;
export const INTERNAL_BINDING_PREFIXES = ['__VOID_', '__PROJECT_', 'CASIMIR_'] as const;
export const INTERNAL_BINDING_EXACT_NAMES = ['ISR_CACHE'] as const;
export const isIsrActive = (): boolean => false;
const key: unique symbol = Symbol.for('void.envContext.v1');
const globals = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<RuntimeEnv> };
export const envContext: AsyncLocalStorage<RuntimeEnv> = (globals[key] ??=
  new AsyncLocalStorage<RuntimeEnv>());
const startupKey = Symbol.for('casimir.startupEnv.v1');
const startup = globalThis as typeof globalThis & { [startupKey]?: RuntimeEnv };

export function asEnv(value: unknown): RuntimeEnv | null {
  return value && typeof value === 'object' && !Array.isArray(value) && !('then' in value)
    ? (value as RuntimeEnv)
    : null;
}
export function setCasimirEnv(value: RuntimeEnv): void {
  startup[startupKey] = Object.freeze({ ...value });
}
export function getRawRuntimeEnv(): RuntimeEnv {
  const value = envContext.getStore() ?? startup[startupKey];
  if (!value) {
    throw new Error('casimir: runtime environment is unavailable.');
  }
  return value;
}
