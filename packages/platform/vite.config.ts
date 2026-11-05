import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: [
      'src/index.ts',
      'src/installer.ts',
      'src/email-protocol.ts',
      'src/plans.ts',
      'src/browser-page.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
  },
});
