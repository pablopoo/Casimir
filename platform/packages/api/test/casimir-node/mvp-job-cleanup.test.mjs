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
function fixture() {
  const engine = new checks.MvpEngine({
    socketPath: '/unused',
    runnerImage: 'sha256:' + 'b'.repeat(64),
    runtime,
    jobTimeoutMs: 1,
  });
  const controller = new AbortController();
  engine.setGuard({
    instance: 'test',
    signal: controller.signal,
    assertLive() {
      if (controller.signal.aborted) {
        throw Error('lost');
      }
    },
    async close() {},
  });
  const op = {
    id: 'cmv_' + 'a'.repeat(12),
    project_id: 'proj_' + 'b'.repeat(12),
    artifact_id: 'car_' + 'c'.repeat(12),
    deployment_id: 'dpl_' + 'd'.repeat(12),
    image_id: 'sha256:' + 'e'.repeat(64),
    runtime,
    phase: 'failed',
  };
  const id = 'f'.repeat(32),
    parameters = { path: '/snapshots/' + id + '.sqlite' },
    body = engine.jobBody(op, 'plan', id, op, parameters);
  engine.imageConfigs.set(body.Image, { Env: [], Entrypoint: body.Entrypoint, Cmd: [] });
  const c = {
    Id: '1'.repeat(64),
    Name: '/casimir-mvp-a-job-' + id,
    Image: body.Image,
    Config: {
      User: body.User,
      Labels: body.Labels,
      Env: body.Env,
      Entrypoint: body.Entrypoint,
      Cmd: [],
    },
    HostConfig: body.HostConfig,
    NetworkSettings: { Networks: { none: {} } },
    State: { Running: true, Status: 'running', ExitCode: 0 },
  };
  const calls = [];
  engine.inspectContainer = async () => c;
  engine.inspectPreparedImage = async () => {};
  engine.transport.request = async (method, path) => {
    calls.push([method, path]);
    if (method === 'GET') {
      return [{ Id: c.Id }];
    }
    if (path.includes('/stop')) {
      c.State.Running = false;
      c.State.Status = 'exited';
    }
    return {};
  };
  return { engine, op, id, parameters, body, c, calls };
}
test('job timeout stops and verifies its exact container before returning failure', async () => {
  const f = fixture();
  assert.equal(typeof f.engine.waitForJob, 'function');
  await assert.rejects(f.engine.waitForJob(f.c, f.body, '/unused'), /job_timeout/);
  assert.equal(f.c.State.Running, false);
  assert.ok(f.calls.some(([method, path]) => method === 'POST' && path.includes('/stop')));
});
test('terminal cleanup validates journal/recipe, stops its own job and never deletes volumes', async () => {
  const f = fixture();
  assert.equal(typeof f.engine.cleanupOperationJobs, 'function');
  const removed = await f.engine.cleanupOperationJobs(f.op, [
    { id: f.id, action: 'plan', parameters: f.parameters, release: f.op },
  ]);
  assert.deepEqual(removed, [f.c.Id]);
  assert.ok(f.calls.some(([method, path]) => method === 'DELETE' && path.endsWith('?v=0')));
  const foreign = fixture();
  foreign.c.Config.Labels['org.casimir.operation'] = 'cmv_' + '9'.repeat(12);
  await assert.rejects(
    foreign.engine.cleanupOperationJobs(foreign.op, [
      { id: foreign.id, action: 'plan', parameters: foreign.parameters, release: foreign.op },
    ]),
    /ownership/,
  );
  assert.ok(!foreign.calls.some(([method]) => method === 'POST' || method === 'DELETE'));
});
