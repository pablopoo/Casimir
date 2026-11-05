import type { VoidConfig } from './config.ts';

/** Define a typed Void project configuration without loading the Vite plugin. */
export function defineConfig<const T extends VoidConfig>(config: T): T {
  return config;
}

export type { VoidConfig } from './config.ts';
