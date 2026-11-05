import { defineConfig } from 'void/config';

// The GitHub container executor deploys the docs from the repository root.
export default defineConfig({
  inference: {
    appType: 'static',
    build: 'vp run build:docs',
    outputDir: 'docs/.vitepress/dist',
  },
});
