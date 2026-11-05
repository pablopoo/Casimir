import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vite-plus/test';

const config = readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8');

it('configures the canonical OAuth callback in every hosted environment', () => {
  expect(
    config.match(/"AUTH_REDIRECT_URI": "https:\/\/api\.void\.cloud\/auth\/callback"/g),
  ).toHaveLength(2);
  expect(
    config.match(/"AUTH_REDIRECT_URI": "https:\/\/api\.staging\.void\.cloud\/auth\/callback"/g),
  ).toHaveLength(1);
});
