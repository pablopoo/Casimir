import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { withMvpControl, artifact, runtime } from './mvp-support.mjs';
const { Pool } = createRequire(new URL('../../package.json', import.meta.url))('pg');
test('image preparation journals intent before Docker and exact image after; restart reuses owned image', async () => {
  assert.equal(typeof checks.prepareArtifactImage, 'function');
  await withMvpControl(async (t) => {
    const id = (await t.request('/projects', { slug: 'mvp-prepare' })).body.id,
      base = `/casimir/v1/projects/${id}`,
      a = artifact();
    const upload = (await t.request(base + '/uploads', { bytes: a.bytes.length, sha256: a.sha256 }))
      .body.uploadId;
    assert.equal(
      (
        await t.request(base + `/uploads/${upload}/content`, undefined, undefined, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
          body: a.bytes,
        })
      ).status,
      200,
    );
    const artifactId = (await t.request(base + `/uploads/${upload}/finalize`, {})).body.artifactId;
    const receipt = (await t.request(base + '/deployments', { artifactId }, 'prepare')).body;
    const pool = new Pool({ connectionString: t.env.DATABASE_URL });
    let builds = 0;
    try {
      const op = checks.mapMvpOperation(
        (
          await t.db.query('SELECT * FROM casimir_mvp_a.operations WHERE id=$1', [
            receipt.operationId,
          ])
        ).rows[0],
      );
      const controller = new AbortController(),
        guard = {
          instance: 'test',
          signal: controller.signal,
          assertLive() {
            if (controller.signal.aborted) {
              throw Error('lost');
            }
          },
          async close() {},
        };
      const image = 'sha256:' + 'b'.repeat(64);
      const engine = {
        async buildArtifact(directory, manifest, operation) {
          builds++;
          const rows = (
            await t.db.query('SELECT * FROM casimir_mvp_a.preparations WHERE operation_id=$1', [
              operation.id,
            ])
          ).rows;
          assert.equal(rows[0].state, 'building');
          assert.equal(manifest.entry, 'dist/ssr/app.js');
          return image;
        },
        async inspectPreparedImage(value) {
          assert.equal(value, image);
        },
      };
      const ctx = {
        db: checks.createDb(pool),
        engine,
        guard,
        profile: { runtime, artifactRoot: join(t.dir, 'artifacts') },
        artifactRoot: join(t.dir, 'artifacts'),
      };
      assert.equal(await checks.prepareArtifactImage(ctx, op), image);
      assert.equal(
        (await t.db.query('SELECT image_id FROM casimir_mvp_a.operations WHERE id=$1', [op.id]))
          .rows[0].image_id,
        image,
      );
      assert.equal(await checks.prepareArtifactImage(ctx, op), image);
      assert.equal(builds, 1);
      controller.abort();
      await assert.rejects(checks.prepareArtifactImage(ctx, op), /lost/);
    } finally {
      await pool.end();
    }
  });
});
