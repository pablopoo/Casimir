import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';

test('MVP engine is separate from the fixed-demo catalog', () => {
  assert.equal(typeof checks.MvpEngine, 'function');
  assert.throws(
    () =>
      new checks.MvpEngine({ socketPath: '/not-used', runnerImage: 'node:latest', runtime: {} }),
    /runner_image/,
  );
});

test('fixed artifact image recipe uses only pinned base and COPY, validates bytes before streaming', async () => {
  assert.equal(typeof checks.artifactImageContext, 'function');
  const root = await mkdtemp('/tmp/casimir-mvp-a-context-');
  const data = Buffer.from('export default {fetch(){return new Response("hello")}};');
  const file = {
    path: 'dist/ssr/app.js',
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  try {
    await mkdir(join(root, 'dist/ssr'), { recursive: true });
    await writeFile(join(root, file.path), data);
    const chunks = [];
    for await (const chunk of checks.artifactImageContext(
      root,
      [file],
      'sha256:' + 'a'.repeat(64),
    )) {
      chunks.push(chunk);
    }
    const tar = Buffer.concat(chunks);
    const text = tar.toString();
    assert.match(text, /FROM sha256:a{64}\nCOPY --chown=1000:1000 payload\/ \/app\/\n/);
    assert.ok(text.includes(data.toString()));
    assert.equal(tar.length % 512, 0);
    assert.doesNotMatch(text, /\nRUN |\nADD |https:\/\//);
    await writeFile(join(root, file.path), 'altered');
    await assert.rejects(async () => {
      for await (const _ of checks.artifactImageContext(root, [file], 'sha256:' + 'a'.repeat(64))) {
        // Drain the stream to exercise deferred validation.
      }
    }, /artifact_changed/);
    await assert.rejects(async () => {
      for await (const _ of checks.artifactImageContext(root, [file], 'node:latest')) {
        // Drain the stream to exercise deferred validation.
      }
    }, /runner_image/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
