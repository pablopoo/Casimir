import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
test('Docker API compatibility rejects missing/malformed versions instead of NaN fail-open', () => {
  assert.equal(typeof checks.verifyDockerApiVersion, 'function');
  for (const value of [
    {},
    { MinAPIVersion: '1.24', ApiVersion: 'bad' },
    { MinAPIVersion: 'bad', ApiVersion: '1.48' },
    { MinAPIVersion: '1.48', ApiVersion: '1.48' },
    { MinAPIVersion: '1.24', ApiVersion: '1.46' },
  ]) {
    assert.throws(() => checks.verifyDockerApiVersion(value), /docker_api_incompatible/);
  }
  checks.verifyDockerApiVersion({ MinAPIVersion: '1.24', ApiVersion: '1.47' });
});
test('raw Docker build transport is bounded, abortable and never exposes daemon text', async () => {
  assert.equal(typeof checks.DockerTransport.prototype.requestBytes, 'function');
  const root = mkdtempSync('/tmp/casimir-mvp-a-transport-'),
    socket = join(root, 'docker.sock');
  let received = '';
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
      received += chunk.toString();
    }
    if (req.url.includes('slow')) {
      return;
    }
    if (req.url.includes('large')) {
      return res.end('x'.repeat(1024 * 1024 + 1));
    }
    if (req.url.includes('error')) {
      return res.end(JSON.stringify({ error: 'secret daemon credential' }));
    }
    res.end(
      JSON.stringify({ stream: 'Step 1' }) +
        '\n' +
        JSON.stringify({ aux: { ID: 'sha256:' + 'a'.repeat(64) } }) +
        '\n',
    );
  });
  await new Promise((r) => server.listen(socket, r));
  const controller = new AbortController();
  let live = true;
  const guard = {
    instance: 'test',
    signal: controller.signal,
    assertLive() {
      if (!live) {
        throw new Error('executor_session_lost');
      }
    },
    async close() {},
  };
  try {
    const transport = new checks.DockerTransport(socket, guard, 100);
    const result = await transport.requestBytes('POST', '/build?ok', Readable.from(['tar bytes']), {
      'Content-Type': 'application/x-tar',
    });
    assert.equal(received, 'tar bytes');
    assert.equal(result.at(-1).aux.ID, 'sha256:' + 'a'.repeat(64));
    await assert.rejects(
      transport.requestBytes('POST', '/build?large', Readable.from(['x']), {}),
      /docker_response_limit/,
    );
    await assert.rejects(
      transport.requestBytes('POST', '/build?error', Readable.from(['x']), {}),
      (e) => e.message === 'docker_build_failed' && !e.message.includes('credential'),
    );
    const waiting = transport.requestBytes('POST', '/build?slow', Readable.from(['x']), {});
    controller.abort();
    await assert.rejects(waiting, /executor_session_lost/);
    live = false;
    await assert.rejects(
      transport.requestBytes('POST', '/build?ok', Readable.from(['x']), {}),
      /executor_session_lost/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});
