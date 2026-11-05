import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'a'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
};
test('snapshot migration jobs have no live-data mount; live readers mount it read-only', () => {
  const engine = new checks.MvpEngine({
    socketPath: '/unused',
    runnerImage: 'sha256:' + 'b'.repeat(64),
    runtime,
  });
  const op = {
    id: 'cmv_' + 'a'.repeat(12),
    project_id: 'proj_' + 'b'.repeat(12),
    artifact_id: 'car_' + 'c'.repeat(12),
    deployment_id: 'dpl_' + 'd'.repeat(12),
    image_id: 'sha256:' + 'e'.repeat(64),
    runtime,
  };
  const id = 'f'.repeat(32);
  for (const action of ['plan', 'apply']) {
    const body = engine.jobBody(op, action, id, op, { path: '/snapshots/' + id + '.sqlite' });
    assert.ok(!body.HostConfig.Mounts.some((m) => m.Source === 'casimir-mvp-a_appdata'));
  }
  for (const action of ['state', 'backup']) {
    const body = engine.jobBody(op, action, id, op, { path: '/data/app.sqlite' });
    assert.equal(
      body.HostConfig.Mounts.find((m) => m.Source === 'casimir-mvp-a_appdata').ReadOnly,
      true,
    );
  }
});
test('retained image identity uses its persisted runtime instead of the current preparation runtime', () => {
  const engine = new checks.MvpEngine({
    socketPath: '/unused',
    runnerImage: 'sha256:' + 'b'.repeat(64),
    runtime,
  });
  const prior = { ...runtime, runtimeId: '9'.repeat(64) };
  const op = {
    id: 'cmv_' + 'a'.repeat(12),
    project_id: 'proj_' + 'b'.repeat(12),
    artifact_id: 'car_' + 'c'.repeat(12),
    runtime: prior,
  };
  assert.equal(engine.labels(op)['org.casimir.runtime-id'], prior.runtimeId);
  const release = { ...op, id: 'cmv_' + '9'.repeat(12), image_id: 'sha256:' + 'e'.repeat(64) };
  const current = { ...op, runtime, image_id: 'sha256:' + 'f'.repeat(64) };
  const job = engine.jobBody(current, 'compatibility', '8'.repeat(32), release, {
    path: '/snapshots/' + '8'.repeat(32) + '.sqlite',
  });
  assert.equal(job.Labels['org.casimir.runtime-id'], prior.runtimeId);
  assert.equal(job.Labels['org.casimir.image-owner'], release.id);
});
test('Docker omitted false ReadOnly fields still validate as writable, while true stays strict', () => {
  const engine = new checks.MvpEngine({
    socketPath: '/unused',
    runnerImage: 'sha256:' + 'b'.repeat(64),
    runtime,
  });
  const op = {
    id: 'cmv_' + 'a'.repeat(12),
    project_id: 'proj_' + 'b'.repeat(12),
    artifact_id: 'car_' + 'c'.repeat(12),
    deployment_id: 'dpl_' + 'd'.repeat(12),
    image_id: 'sha256:' + 'e'.repeat(64),
    runtime,
  };
  const body = engine.jobBody(op, 'state', 'f'.repeat(32));
  engine.imageConfigs.set(body.Image, { Env: [], Entrypoint: body.Entrypoint, Cmd: [] });
  const actual = {
    Image: body.Image,
    Config: {
      User: body.User,
      Labels: body.Labels,
      Env: body.Env,
      Entrypoint: body.Entrypoint,
      Cmd: [],
    },
    HostConfig: structuredClone(body.HostConfig),
    NetworkSettings: { Networks: { none: {} } },
  };
  for (const mount of actual.HostConfig.Mounts) {
    if (mount.ReadOnly === false) {
      delete mount.ReadOnly;
    }
  }
  assert.doesNotThrow(() => engine.assertBody(actual, body));
  actual.HostConfig.Mounts.find((m) => m.ReadOnly === true).ReadOnly = false;
  assert.throws(() => engine.assertBody(actual, body), /resource_recipe/);
});
test('fixed app and snapshot compatibility recipes isolate mounts and do not inherit control credentials', () => {
  const engine = new checks.MvpEngine({
    socketPath: '/unused',
    runnerImage: 'sha256:' + 'b'.repeat(64),
    runtime,
  });
  assert.equal(typeof engine.containerBody, 'function');
  const op = {
    id: 'cmv_' + 'a'.repeat(12),
    project_id: 'proj_' + 'b'.repeat(12),
    artifact_id: 'car_' + 'c'.repeat(12),
    deployment_id: 'dpl_' + 'd'.repeat(12),
    image_id: 'sha256:' + 'e'.repeat(64),
    runtime,
  };
  const app = engine.containerBody(op);
  assert.equal(app.User, '1000:1000');
  assert.equal(app.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(app.HostConfig.PidsLimit, 64);
  assert.equal(app.HostConfig.ReadonlyRootfs, true);
  assert.equal(app.HostConfig.NetworkMode, 'casimir-mvp-a_apps');
  assert.deepEqual(app.Env, ['NODE_ENV=production']);
  assert.ok(!JSON.stringify(app).includes('docker.sock'));
  const job = engine.jobBody(op, 'compatibility', 'f'.repeat(32));
  assert.equal(job.HostConfig.NetworkMode, 'none');
  assert.ok(job.HostConfig.Mounts.some((m) => m.Source === 'casimir-mvp-a_snapshots'));
  assert.ok(!job.HostConfig.Mounts.some((m) => m.Source === 'casimir-mvp-a_appdata'));
  assert.deepEqual(job.Entrypoint, ['node', '/runner/job.mjs']);
});
