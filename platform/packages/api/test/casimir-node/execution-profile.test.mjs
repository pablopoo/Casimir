import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { catalog } from './execution-support.mjs';
test('operator catalog is strict, immutable-ID-only and canonically fingerprinted', () => {
  assert.equal(typeof checks.loadProfile, 'function', 'execution profile loader must exist');
  const dir = mkdtempSync(join(tmpdir(), 'casimir-profile-'));
  const file = join(dir, 'catalog.json');
  const load = (value) => {
    writeFileSync(file, JSON.stringify(value));
    return checks.loadProfile(file);
  };
  try {
    const a = load(catalog),
      b = load({
        ...catalog,
        images: {
          'demo-broken': catalog.images['demo-broken'],
          'demo-v2': catalog.images['demo-v2'],
          'demo-v1': catalog.images['demo-v1'],
        },
      });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.match(a.fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(
      a.fingerprint,
      load({ ...catalog, images: { ...catalog.images, 'demo-v1': 'sha256:' + '4'.repeat(64) } })
        .fingerprint,
    );
    for (const bad of [
      { ...catalog, command: 'sh' },
      { ...catalog, recipeVersion: 2 },
      { ...catalog, images: { ...catalog.images, other: 'sha256:' + '4'.repeat(64) } },
      { ...catalog, images: { ...catalog.images, 'demo-v1': 'node:latest' } },
      { ...catalog, appPort: 80 },
      { ...catalog, scope: 'foreign-scope' },
    ])
      assert.throws(() => load(bad), /invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
