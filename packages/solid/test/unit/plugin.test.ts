import type { Plugin } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { voidSolid } from '../../src/plugin.ts';

type ConfigPlugin = Plugin & {
  config(): {
    optimizeDeps?: { exclude?: Array<string> };
    ssr?: {
      noExternal?: Array<string>;
      optimizeDeps?: { exclude?: Array<string> };
    };
  };
  configEnvironment(): { optimizeDeps?: { exclude?: Array<string> } };
};

describe('voidSolid config plugin', () => {
  it('excludes the raw Solid runtime from every dep optimizer environment', () => {
    const configPlugin = voidSolid()[0] as ConfigPlugin;
    const config = configPlugin.config();
    const environmentConfig = configPlugin.configEnvironment();

    expect(config.optimizeDeps?.exclude).toContain('@void/solid');
    expect(config.ssr?.noExternal).toContain('@void/solid');
    expect(config.ssr?.optimizeDeps?.exclude).toContain('@void/solid');
    expect(environmentConfig.optimizeDeps?.exclude).toContain('@void/solid');
  });
});
