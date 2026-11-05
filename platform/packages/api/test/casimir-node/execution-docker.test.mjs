import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
test('Docker transport pins API and bounds errors without exposing daemon text', async () => {
  assert.equal(typeof checks.DockerTransport, 'function', 'bounded Docker transport must exist');
  const dir = mkdtempSync('/tmp/casimir-engine-'),
    socket = join(dir, 'engine.sock');
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    if (req.url.endsWith('/slow')) return;
    if (req.url.endsWith('/large')) return res.end('x'.repeat(1024 * 1024 + 1));
    if (req.url.endsWith('/collision')) {
      res.writeHead(409);
      return res.end('credential-bearing daemon detail');
    }
    if (req.url.endsWith('/invalid')) return res.end('{bad');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(socket, r));
  try {
    const transport = new checks.DockerTransport(socket, undefined, 100);
    assert.deepEqual(await transport.request('GET', '/ok'), { ok: true });
    assert.equal(paths[0], '/v1.47/ok');
    for (const [path, code] of [
      ['/slow', 'docker_timeout'],
      ['/large', 'docker_response_limit'],
      ['/invalid', 'docker_invalid_response'],
      ['/collision', 'docker_conflict'],
    ])
      await assert.rejects(transport.request('GET', path), (e) => e.message === code);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('fixed engine validates Docker compatibility and never mutates without a live guard', async () => {
  assert.equal(typeof checks.createEngine, 'function', 'fixed engine must exist');
  const { catalog } = await import('./execution-support.mjs');
  const engine = checks.createEngine({
    socketPath: '/missing.sock',
    profile: { ...catalog, fingerprint: 'a'.repeat(64) },
  });
  await assert.rejects(engine.start('a'.repeat(64)), /executor guard required/);
  assert.throws(() => engine.candidateName({ id: '../../evil' }), /invalid operation/);
});
test('route store detects unexpected content and compares expected fingerprint', async () => {
  assert.equal(typeof checks.RouteStore, 'function', 'route store must exist');
  const dir = mkdtempSync('/tmp/casimir-route-');
  try {
    const store = new checks.RouteStore(dir);
    await store.initialize();
    const first = await store.read();
    assert.equal(first.target, null);
    await assert.rejects(
      store.replace({ ...first, fingerprint: '0'.repeat(64) }, null),
      /route conflict/,
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'route.conf'), 'unexpected route');
    await assert.rejects(store.read(), /route invalid/);
    await assert.rejects(store.initialize(), /route invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('proxy uses a Docker short DNS identity within the DNS label limit', async () => {
  assert.equal(typeof checks.routeConfig, 'function');
  const id = 'a'.repeat(64);
  const config = checks.routeConfig({
    projectId: 'proj_abcdefghijkl',
    deploymentId: 'dpl_abcdefghijkl',
    containerId: id,
    imageId: 'sha256:' + '1'.repeat(64),
    version: 'v1',
  });
  const host = /set \$casimir_target ([^:]+):3000/.exec(config)[1];
  assert.ok(
    host.length <= 63,
    'Docker DNS labels cannot contain the full64-character container ID',
  );
  assert.equal(host, id.slice(0, 12));
});
test('route fingerprint survives PostgreSQL jsonb key reordering', () => {
  const target = {
    projectId: 'proj_abcdefghijkl',
    deploymentId: 'dpl_abcdefghijkl',
    containerId: 'a'.repeat(64),
    imageId: 'sha256:' + '1'.repeat(64),
    version: 'v1',
  };
  const reordered = Object.fromEntries(Object.entries(target).reverse());
  assert.equal(checks.routeConfig(target), checks.routeConfig(reordered));
});
test('fixed engine refuses foreign named volumes before runtime mutation', async () => {
  const { catalog } = await import('./execution-support.mjs');
  const dir = mkdtempSync('/tmp/casimir-environment-'),
    socket = join(dir, 'engine.sock');
  const server = createServer((req, res) => {
    if (req.url.endsWith('/version'))
      return res.end(JSON.stringify({ MinAPIVersion: '1.40', ApiVersion: '1.56' }));
    const image = /\/images\/(sha256:[a-f0-9]{64})\/json$/.exec(req.url);
    if (image) return res.end(JSON.stringify({ Id: image[1] }));
    if (req.url.includes('/networks/'))
      return res.end(
        JSON.stringify({ Internal: true, Labels: { 'org.casimir.task': 'execution-poc' } }),
      );
    res.end(JSON.stringify({ Labels: { 'org.casimir.task': 'foreign' } }));
  });
  await new Promise((r) => server.listen(socket, r));
  try {
    await assert.rejects(
      checks
        .createEngine({ socketPath: socket, profile: { ...catalog, fingerprint: 'a'.repeat(64) } })
        .verifyEnvironment(),
      /resource ownership mismatch/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('candidate identity and inflight profile drift fail before mutations', async () => {
  const { catalog } = await import('./execution-support.mjs');
  const profile = { ...catalog, fingerprint: 'a'.repeat(64) },
    engine = checks.createEngine({ socketPath: '/missing.sock', profile });
  const op = {
    id: 'cex_abcdefghijkl',
    project_id: 'proj_abcdefghijkl',
    deployment_id: 'dpl_abcdefghijkl',
    image_id: catalog.images['demo-v1'],
    image_alias: 'demo-v1',
    profile_hash: profile.fingerprint,
  };
  assert.throws(
    () => engine.validateCandidate(op, { Image: catalog.images['demo-v2'] }),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      engine.validateCandidate(op, {
        Image: op.image_id,
        Config: { Labels: { 'org.casimir.task': 'foreign' } },
      }),
    /identity mismatch/,
  );
  const controller = new AbortController();
  let effects = 0;
  engine.setGuard({
    instance: 'test',
    signal: controller.signal,
    assertLive() {
      effects++;
    },
  });
  await assert.rejects(
    engine.ensureCandidate({ ...op, profile_hash: 'b'.repeat(64) }, 'read-only'),
    /profile drift/,
  );
  assert.equal(effects, 1, 'guard checked but no Docker request could reach the missing socket');
});
test('startup resolves owned interrupted jobs before resuming and refuses foreign job recipes', async () => {
  const { catalog } = await import('./execution-support.mjs');
  const profile = { ...catalog, fingerprint: 'a'.repeat(64) };
  const op = {
    id: 'cex_abcdefghijkl',
    project_id: 'proj_abcdefghijkl',
    profile_hash: profile.fingerprint,
    executor_instance: '11111111-1111-4111-8111-111111111111',
  };
  const dir = mkdtempSync('/tmp/casimir-jobs-'),
    socket = join(dir, 'engine.sock');
  let container,
    refuse = false;
  const effects = [];
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://docker');
    if (req.method === 'GET' && url.pathname.endsWith('/containers/json'))
      return res.end(JSON.stringify(container ? [{ Id: container.Id, State: 'running' }] : []));
    if (req.method === 'GET') return res.end(JSON.stringify(container));
    effects.push(url.pathname);
    if (url.pathname.endsWith('/create')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      container = {
        Id: 'b'.repeat(64),
        Name: '/' + url.searchParams.get('name'),
        Image: body.Image,
        Config: body,
        HostConfig: body.HostConfig,
        State: { Running: false },
        Mounts: body.HostConfig.Mounts.map((m) => ({
          Name: m.Source,
          Destination: m.Target,
          RW: !m.ReadOnly,
        })),
      };
      return res.end(JSON.stringify({ Id: container.Id }));
    }
    if (url.pathname.endsWith('/start')) {
      container.State.Running = true;
      return res.end('{}');
    }
    if (url.pathname.endsWith('/wait')) {
      controller.abort();
      return res.destroy();
    }
    if (url.pathname.endsWith('/stop')) {
      container.State.Running = false;
      return res.end('{}');
    }
    if (req.method === 'DELETE') {
      container = null;
      return res.end('{}');
    }
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise((r) => server.listen(socket, r));
  const guard = (signal, instance) => ({
    instance,
    signal,
    assertLive() {
      if (signal.aborted) throw Error('executor_session_lost');
    },
  });
  try {
    const engine = checks.createEngine({ socketPath: socket, profile });
    engine.setGuard(guard(controller.signal, op.executor_instance));
    await assert.rejects(engine.initializeAppData(op.project_id, op), /executor_session_lost/);
    assert.ok(container.State.Running, 'old writable initializer survives interrupted owner');
    const replacement = checks.createEngine({ socketPath: socket, profile });
    replacement.setGuard(
      guard(new AbortController().signal, '22222222-2222-4222-8222-222222222222'),
    );
    assert.equal(
      typeof replacement.reconcileJobs,
      'function',
      'startup must reconcile durable job ownership',
    );
    const valid = structuredClone(container);
    container.Config.Labels['org.casimir.profile'] = 'foreign';
    const before = effects.length;
    await assert.rejects(
      replacement.reconcileJobs(async () => op),
      /job ownership mismatch/,
    );
    assert.equal(effects.length, before, 'foreign jobs are not stopped or removed');
    container = valid;
    await replacement.reconcileJobs(async () => op);
    assert.equal(
      container,
      null,
      'replacement must stop and remove old writable job before continuing',
    );
    assert.ok(effects.at(-2).endsWith('/stop'));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
