import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { withMvpControl, artifact, runtime } from './mvp-support.mjs';
const { Pool } = createRequire(new URL('../../package.json', import.meta.url))('pg');
test('durable MVP runner closes ingress before writing and journals exposure before opening', async () => {
  assert.equal(typeof checks.runMvpOperation, 'function');
  await withMvpControl(async (t) => {
    const id = (await t.request('/projects', { slug: 'mvp-flow' })).body.id,
      base = `/casimir/v1/projects/${id}`,
      a = artifact();
    const upload = (await t.request(base + '/uploads', { bytes: a.bytes.length, sha256: a.sha256 }))
      .body.uploadId;
    await t.request(base + `/uploads/${upload}/content`, undefined, undefined, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
      body: a.bytes,
    });
    const artifactId = (await t.request(base + `/uploads/${upload}/finalize`, {})).body.artifactId;
    const receipt = (await t.request(base + '/deployments', { artifactId }, 'flow')).body;
    const pool = new Pool({ connectionString: t.env.DATABASE_URL }),
      controller = new AbortController();
    try {
      const routes = new checks.MvpRouteStore(join(t.dir, 'routes'));
      await routes.initialize();
      let writer = false,
        opened = false;
      let failOperation = null,
        foreign = false,
        restores = 0;
      const image = 'sha256:' + 'b'.repeat(64),
        container = 'c'.repeat(64),
        digest = 'd'.repeat(64);
      const engine = {
        async buildArtifact() {
          return image;
        },
        async inspectPreparedImage() {},
        async prepareSecrets() {
          return digest;
        },
        async runJob(op, action, _id, parameters) {
          if (action === 'restore') {
            restores++;
          }
          if (action === 'plan') {
            return {
              files: [],
              pending: [],
              priorSchemaDigest: digest,
              priorHistoryDigest: digest,
              fingerprint: digest,
            };
          }
          if (action === 'apply' && parameters.path === '/data/app.sqlite') {
            assert.equal((await routes.read()).target, null);
            assert.equal(writer, false);
          }
          if (action === 'apply') {
            return { applied: [], schemaDigest: digest, fingerprint: digest, sha256: digest };
          }
          if (action === 'backup') {
            return { sha256: digest, schemaDigest: digest };
          }
          return { history: [], schema: { objects: [], tables: {} } };
        },
        async startApp() {
          assert.equal(writer, false);
          writer = true;
          return container;
        },
        async stopApp() {
          writer = false;
        },
        async privateProbe(op) {
          if (op.id === failOperation) {
            foreign = true;
            throw Error('candidate_failed');
          }
        },
        async assertSingleWriter(op) {
          if (!op && foreign) {
            throw Error('writer_conflict');
          }
        },
        async reloadProxy() {},
        async observeIngress(op) {
          if (op) {
            const row = (
              await t.db.query(
                'SELECT phase,exposure_started FROM casimir_mvp_a.operations WHERE id=$1',
                [op.id],
              )
            ).rows[0];
            assert.equal(row.phase, foreign ? 'succeeded' : 'exposure_started');
            assert.ok(row.exposure_started);
            opened = true;
          }
        },
      };
      const ctx = {
        db: checks.createDb(pool),
        guard: {
          instance: 'test',
          signal: controller.signal,
          assertLive() {
            if (controller.signal.aborted) {
              throw Error('lost');
            }
          },
        },
        engine,
        routes,
        profile: { runtime, artifactRoot: join(t.dir, 'artifacts') },
        artifactRoot: join(t.dir, 'artifacts'),
      };
      const result = await checks.runMvpOperation(ctx, receipt.operationId);
      assert.equal(result.phase, 'succeeded');
      assert.equal(opened, true);
      assert.equal(
        (await t.db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [id])).rows[0]
          .active_deployment_id,
        receipt.deploymentId,
      );
      assert.equal((await checks.runMvpOperation(ctx, receipt.operationId)).phase, 'succeeded');
      const nextUpload = (
        await t.request(base + '/uploads', { bytes: a.bytes.length, sha256: a.sha256 })
      ).body.uploadId;
      await t.request(base + `/uploads/${nextUpload}/content`, undefined, undefined, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
        body: a.bytes,
      });
      const nextArtifact = (await t.request(base + `/uploads/${nextUpload}/finalize`, {})).body
        .artifactId;
      const next = (
        await t.request(base + '/deployments', { artifactId: nextArtifact }, 'foreign-writer')
      ).body;
      failOperation = next.operationId;
      assert.equal(
        (await checks.runMvpOperation(ctx, next.operationId)).phase,
        'recovery_required',
      );
      assert.equal(restores, 0);
      assert.equal(writer, false);
      assert.equal((await routes.read()).target, null);
    } finally {
      await pool.end();
    }
  });
});
