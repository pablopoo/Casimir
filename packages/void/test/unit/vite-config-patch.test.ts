import { describe, expect, it } from 'vite-plus/test';
import { patchViteConfigWithVoidPlugin } from '../../src/cli/vite-config-patch.ts';

describe('Vite config patching', () => {
  it('ignores plugin text in comments, strings, and regular expressions', () => {
    const source = `import { defineConfig } from 'vite';
// voidPlugin()
const message = 'voidPlugin()';
const pattern = /[{}]/;
export default defineConfig({ plugins: [other()] });
`;
    const updated = patchViteConfigWithVoidPlugin('vite.config.ts', source)!;
    expect(updated).toContain('plugins: [voidPlugin(), other()]');
    expect(updated).toContain('const pattern = /[{}]/;');
    expect(updated).toContain('import { voidPlugin } from "void";');
    expect(patchViteConfigWithVoidPlugin('vite.config.ts', updated)).toBe(updated);
  });

  it('reuses an aliased import of voidPlugin', () => {
    const source = `import { voidPlugin as voidVite } from 'void';
export default { plugins: [] };
`;
    const updated = patchViteConfigWithVoidPlugin('vite.config.ts', source)!;
    expect(updated).toContain('plugins: [voidVite()]');
    expect(updated.match(/from 'void'/g)).toHaveLength(1);
  });

  it('inserts an import after a multiline import declaration', () => {
    const source = `import {
  defineConfig,
} from 'vite';
export default defineConfig({});
`;
    const updated = patchViteConfigWithVoidPlugin('vite.config.ts', source)!;
    expect(updated).toContain('} from \'vite\';\nimport { voidPlugin } from "void";\n');
    expect(updated).toContain('plugins: [voidPlugin()]');
  });

  it('leaves dynamic plugin properties for manual setup', () => {
    const source = `export default { plugins: getPlugins() }`;
    expect(patchViteConfigWithVoidPlugin('vite.config.ts', source)).toBeUndefined();
  });
});
