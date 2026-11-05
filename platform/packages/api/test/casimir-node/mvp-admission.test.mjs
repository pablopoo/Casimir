import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { withMvpControl, artifact, runtime } from './mvp-support.mjs';
async function project(t, slug = 'mvp-notes') {
  const p = await t.request('/projects', { slug });
  assert.equal(p.status, 201);
  return p.body.id;
}
async function upload(t, id, a = artifact()) {
  const path = `/casimir/v1/projects/${id}`;
  const session = await t.request(path + '/uploads', { bytes: a.bytes.length, sha256: a.sha256 });
  assert.equal(session.status, 201, JSON.stringify(session.body));
  const content = await t.request(
    path + `/uploads/${session.body.uploadId}/content`,
    undefined,
    undefined,
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN,
        'Content-Type': 'application/octet-stream',
      },
      body: a.bytes,
    },
  );
  assert.equal(content.status, 200, JSON.stringify(content.body));
  return { a, path, uploadId: session.body.uploadId };
}
test('new admission rejects a formerly finalized runtime while existing receipts remain idempotent', async () =>
  withMvpControl(async (t) => {
    const id = await project(t, 'runtime-change'),
      u = await upload(t, id);
    const artifactId = (await t.request(u.path + `/uploads/${u.uploadId}/finalize`, {})).body
      .artifactId;
    const prior = await t.request(u.path + '/deployments', { artifactId }, 'prior-runtime');
    assert.equal(prior.status, 202);
    await t.db.query("UPDATE casimir_mvp_a.operations SET phase='failed' WHERE id=$1", [
      prior.body.operationId,
    ]);
    await writeFile(
      join(t.dir, 'profile.json'),
      JSON.stringify({
        runtime: { ...runtime, runtimeId: 'b'.repeat(64) },
        artifactRoot: join(t.dir, 'artifacts'),
      }),
    );
    await t.restart();
    assert.deepEqual(
      await t.request(u.path + '/deployments', { artifactId }, 'prior-runtime'),
      prior,
    );
    assert.equal(
      (await t.request(u.path + '/deployments', { artifactId }, 'new-runtime-key')).status,
      409,
    );
    assert.equal(
      (await t.db.query('SELECT count(*) AS count FROM casimir_mvp_a.operations')).rows[0].count,
      '1',
    );
  }));
test(
  'finalize_is_durable_owned_and_idempotent; route-specific limits and deployment keys',
  { timeout: 60000 },
  async () =>
    withMvpControl(async (t) => {
      assert.deepEqual((await t.request('/casimir/v1/info')).body, runtime);
      assert.equal(
        (await t.request('/casimir/v1/identity', undefined, undefined, { headers: {} })).status,
        401,
      );
      const id = await project(t);
      const u = await upload(t, id);
      assert.ok(u.a.bytes.length > 16384);
      const complete = () => t.request(u.path + `/uploads/${u.uploadId}/finalize`, {});
      const result = await complete();
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const artifactId = result.body.artifactId;
      assert.ok(artifactId);
      assert.deepEqual(await complete(), result);
      await t.restart();
      assert.deepEqual(await complete(), result);
      const row = (
        await t.db.query('SELECT * FROM casimir_mvp_a.artifacts WHERE id=$1', [artifactId])
      ).rows[0];
      assert.equal(row.sha256, u.a.sha256);
      assert.equal((await stat(join(t.dir, 'artifacts', row.path))).size, u.a.bytes.length);
      assert.deepEqual(await readFile(join(t.dir, 'artifacts', row.path)), u.a.bytes);
      assert.equal(
        (await t.request(u.path + '/uploads', { bytes: 1, sha256: u.a.sha256, extra: true }))
          .status,
        400,
      );
      assert.equal(
        (await t.request(u.path + '/uploads', { padding: 'x'.repeat(17000) })).status,
        413,
      );
      const intent = () => t.request(u.path + '/deployments', { artifactId }, 'same-key');
      const receipt = await intent();
      assert.equal(receipt.status, 202, JSON.stringify(receipt.body));
      assert.deepEqual(await intent(), receipt);
      const op = await t.request(u.path + '/operations/' + receipt.body.operationId);
      assert.equal(op.status, 200);
      assert.equal(op.body.phase, 'queued');
      assert.equal(op.body.desired.deploymentId, receipt.body.deploymentId);
      assert.equal(op.body.verifiedServing, null);
      assert.equal(JSON.stringify(op.body).includes(t.dir), false);
      assert.equal(
        (await t.request(u.path + '/deployments', { artifactId, extra: true }, 'other')).status,
        400,
      );
      const second = await upload(t, id);
      const secondId = (await t.request(second.path + `/uploads/${second.uploadId}/finalize`, {}))
        .body.artifactId;
      assert.equal(
        (await t.request(u.path + '/deployments', { artifactId: secondId }, 'same-key')).status,
        409,
      );
      assert.equal(
        (await t.request(u.path + '/deployments', { artifactId: secondId }, 'other-key')).status,
        409,
      );
      assert.equal(
        (await t.db.query('SELECT count(*)::int n FROM casimir_mvp_a.operations')).rows[0].n,
        1,
      );
      await t.db.query(
        'UPDATE casimir_mvp_a.operations SET error=$1,observation=$2::jsonb WHERE id=$3',
        [
          t.dir,
          JSON.stringify({
            deploymentId: receipt.body.deploymentId,
            artifactId,
            imageId: 'sha256:' + 'a'.repeat(64),
            observedAt: new Date().toISOString(),
            privatePath: t.dir,
          }),
          receipt.body.operationId,
        ],
      );
      const sanitized = (await t.request(u.path + '/operations/' + receipt.body.operationId)).body;
      assert.equal(JSON.stringify(sanitized).includes(t.dir), false);
      assert.equal(sanitized.error, 'operation_failed');
      const spare = await t.request(`/projects/${id}/deployments`, {});
      assert.equal(spare.status, 201);
      const duplicate = (newId, dpl, key, phase) =>
        t.db.query(
          `INSERT INTO casimir_mvp_a.operations(id,project_id,actor_id,artifact_id,deployment_id,idempotency_key,input_hash,phase,runtime) SELECT $1,project_id,actor_id,artifact_id,$2,$3,input_hash,$4,runtime FROM casimir_mvp_a.operations WHERE id=$5`,
          [newId, dpl, key, phase, receipt.body.operationId],
        );
      await assert.rejects(
        duplicate('same_key', spare.body.id, 'same-key', 'failed'),
        (e) => e.code === '23505' && e.constraint.includes('idempotency'),
      );
      await assert.rejects(
        duplicate('same_deployment', receipt.body.deploymentId, 'different', 'failed'),
        (e) => e.code === '23505' && e.constraint.includes('deployment_id'),
      );
      await assert.rejects(
        duplicate('active_conflict', spare.body.id, 'different', 'queued'),
        (e) => e.code === '23505' && e.constraint === 'mvp_one_blocking_project',
      );
      await t.db.query(
        "UPDATE casimir_mvp_a.operations SET phase='failed',outcome='test_terminal' WHERE id=$1",
        [receipt.body.operationId],
      );
      assert.deepEqual(await intent(), receipt);
      const other = await project(t, 'mvp-other');
      assert.equal(
        (
          await t.request(`/casimir/v1/projects/${other}/uploads`, {
            bytes: u.a.bytes.length,
            sha256: u.a.sha256,
          })
        ).status,
        409,
      );
      await t.db.query(
        "INSERT INTO users(id,provider,provider_id,login,email,plan,role) VALUES('foreign_owner','casimir-local','foreign_owner','foreign','foreign@example.invalid','free','user')",
      );
      await t.db.query("UPDATE projects SET user_id='foreign_owner' WHERE id=$1", [id]);
      assert.ok([403, 404].includes((await intent()).status));
      assert.ok(
        [403, 404].includes(
          (await t.request(u.path + '/operations/' + receipt.body.operationId)).status,
        ),
      );
    }),
);
test(
  'disconnected_upload_is_not_admitted; invalid bytes and misleading declared size',
  { timeout: 60000 },
  async () =>
    withMvpControl(async (t) => {
      const id = await project(t);
      const a = artifact(),
        path = `/casimir/v1/projects/${id}`;
      const session = await t.request(path + '/uploads', {
        bytes: a.bytes.length,
        sha256: a.sha256,
      });
      assert.equal(session.status, 201);
      await new Promise((resolve) => {
        const req = httpRequest(t.base + path + `/uploads/${session.body.uploadId}/content`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN,
            'Content-Length': String(a.bytes.length),
          },
        });
        req.on('error', () => resolve());
        req.on('close', resolve);
        req.write(a.bytes.subarray(0, 100));
        setTimeout(() => req.destroy(), 100);
      });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        (await t.request(path + `/uploads/${session.body.uploadId}/finalize`, {})).status,
        409,
      );
      assert.equal(
        (await t.db.query('SELECT count(*)::int n FROM casimir_mvp_a.artifacts')).rows[0].n,
        0,
      );
      assert.equal(
        (await t.request(path + '/deployments', { artifactId: 'unfinalized' }, 'bad')).status,
        409,
      );
      const wrong = await t.request(path + '/uploads', { bytes: 1, sha256: a.sha256 });
      const response = await t.request(
        path + `/uploads/${wrong.body.uploadId}/content`,
        undefined,
        undefined,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
          body: a.bytes,
        },
      );
      assert.equal(response.status, 413);
      assert.equal(
        (await t.db.query('SELECT count(*)::int n FROM casimir_mvp_a.operations')).rows[0].n,
        0,
      );
      const invalid = await t.request(path + '/uploads', {
        bytes: a.bytes.length,
        sha256: '0'.repeat(64),
      });
      assert.equal(
        (
          await t.request(
            path + `/uploads/${invalid.body.uploadId}/content`,
            undefined,
            undefined,
            {
              method: 'PUT',
              headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
              body: a.bytes,
            },
          )
        ).status,
        400,
      );
      assert.equal(
        (await t.request(path + `/uploads/${invalid.body.uploadId}/finalize`, {})).status,
        409,
      );
    }),
);

test(
  'SQL finalization failure leaves only an expirable unreferenced file; migration drift blocks readiness',
  { timeout: 60000 },
  async () =>
    withMvpControl(async (t) => {
      const { createDb, expireMvpUploads } = await import('../../../../../casimir/dist/checks.mjs');
      const id = await project(t),
        u = await upload(t, id);
      await t.db.query(
        "CREATE FUNCTION casimir_mvp_a.reject_artifact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected artifact SQL failure'; END $$",
      );
      await t.db.query(
        'CREATE TRIGGER reject_artifact BEFORE INSERT ON casimir_mvp_a.artifacts FOR EACH ROW EXECUTE FUNCTION casimir_mvp_a.reject_artifact()',
      );
      assert.equal((await t.request(u.path + `/uploads/${u.uploadId}/finalize`, {})).status, 503);
      assert.equal(
        (await t.db.query('SELECT count(*)::int n FROM casimir_mvp_a.artifacts')).rows[0].n,
        0,
      );
      const sealed = join(t.dir, 'artifacts', 'sealed', u.uploadId + '.gz');
      assert.equal((await stat(sealed)).size, u.a.bytes.length);
      await t.db.query('DROP TRIGGER reject_artifact ON casimir_mvp_a.artifacts');
      // A restart/retry can reuse the durable orphan without duplicating an artifact.
      await t.restart();
      const retried = await t.request(u.path + `/uploads/${u.uploadId}/finalize`, {});
      assert.equal(retried.status, 200);
      assert.equal(
        spawnSync(process.execPath, ['casimir/mvp-a/migrate.mjs'], { env: t.env, encoding: 'utf8' })
          .status,
        0,
      );
      assert.equal(
        (
          await t.db.query('SELECT id FROM casimir_mvp_a.artifacts WHERE upload_id=$1', [
            u.uploadId,
          ])
        ).rows[0].id,
        retried.body.artifactId,
      );
      const abandoned = await upload(t, id);
      await t.db.query(
        'CREATE TRIGGER reject_artifact BEFORE INSERT ON casimir_mvp_a.artifacts FOR EACH ROW EXECUTE FUNCTION casimir_mvp_a.reject_artifact()',
      );
      assert.equal(
        (await t.request(abandoned.path + `/uploads/${abandoned.uploadId}/finalize`, {})).status,
        503,
      );
      await t.db.query(
        "UPDATE casimir_mvp_a.uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
        [abandoned.uploadId],
      );
      assert.equal(
        await expireMvpUploads(createDb(t.db), { runtime, artifactRoot: join(t.dir, 'artifacts') }),
        1,
      );
      await assert.rejects(stat(join(t.dir, 'artifacts', 'sealed', abandoned.uploadId + '.gz')), {
        code: 'ENOENT',
      });
      assert.ok(await stat(sealed));
      await t.db.query("UPDATE casimir_mvp_a.schema_migrations SET hash=repeat('0',64)");
      assert.equal((await t.request('/health')).status, 503);
      assert.equal((await t.request('/casimir/v1/identity')).status, 503);
      assert.equal(
        spawnSync(process.execPath, ['casimir/mvp-a/migrate.mjs'], { env: t.env, encoding: 'utf8' })
          .status,
        1,
      );
    }),
);
