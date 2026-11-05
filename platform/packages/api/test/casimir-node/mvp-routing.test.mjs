import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
test('interrupted temporary route files cannot obstruct either ingress gate direction', async () => {
  const root = await mkdtemp('/tmp/casimir-mvp-a-interrupted-route-');
  try {
    // The old writer may have died with a partial temp file, before any route.
    await writeFile(join(root, 'route.conf.next'), 'partial interrupted route');
    let routes = new checks.MvpRouteStore(root);
    await routes.initialize();
    const target = {
      projectId: 'proj_' + 'a'.repeat(12),
      deploymentId: 'dpl_' + 'b'.repeat(12),
      artifactId: 'car_' + 'c'.repeat(12),
      containerId: 'd'.repeat(64),
      imageId: 'sha256:' + 'e'.repeat(64),
    };
    const closed = await routes.read();
    // A normal write failure also must clean up just its own partial temp file.
    await assert.rejects(
      routes.replace(closed, { ...target, containerId: 'invalid' }),
      /route_invalid/,
    );
    const active = await routes.replace(closed, target);
    await writeFile(
      join(root, 'route.conf.' + 'a'.repeat(32) + '.next'),
      'another interrupted attempt',
    );
    routes = new checks.MvpRouteStore(root);
    await routes.replace(active, null);
    await routes.replace(await routes.read(), target);
    assert.deepEqual((await routes.read()).target, target);
    assert.equal(
      await readFile(join(root, 'route.conf.next'), 'utf8'),
      'partial interrupted route',
    );
    assert.deepEqual(
      (await readdir(root)).sort(),
      ['route.conf', 'route.conf.' + 'a'.repeat(32) + '.next', 'route.conf.next'].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('MVP route maintenance is durable, conditional and blocks private runtime paths', async () => {
  assert.equal(typeof checks.MvpRouteStore, 'function');
  const root = await mkdtemp('/tmp/casimir-mvp-a-routes-');
  try {
    const routes = new checks.MvpRouteStore(root);
    await routes.initialize();
    const closed = await routes.read();
    assert.equal(closed.target, null);
    const target = {
      projectId: 'proj_' + 'a'.repeat(12),
      deploymentId: 'dpl_' + 'b'.repeat(12),
      artifactId: 'car_' + 'c'.repeat(12),
      containerId: 'd'.repeat(64),
      imageId: 'sha256:' + 'e'.repeat(64),
    };
    const active = await routes.replace(closed, target);
    assert.match(checks.mvpRouteConfig(target), /proxy_set_header Host \$http_host;/);
    assert.deepEqual(active.target, target);
    assert.match(checks.mvpRouteConfig(target), /location \^~ \/_casimir\/ \{ return 404; \}/);
    await assert.rejects(routes.replace(closed, null), /conflict/);
    await routes.replace(active, null);
    assert.equal((await new checks.MvpRouteStore(root).read()).target, null);
    await writeFile(join(root, 'route.conf'), 'foreign');
    await assert.rejects(routes.read(), /route_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
