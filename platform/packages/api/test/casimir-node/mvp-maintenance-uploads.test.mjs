import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { withMvpControl, artifact } from './mvp-support.mjs';

const installationId = '1'.repeat(32);

async function project(t) {
  const response = await t.request('/projects', { slug: 'maintenance-uploads' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  await t.db.query('CREATE SCHEMA casimir_install');
  await t.db.query(`
    CREATE TABLE casimir_install.installation(
      id integer PRIMARY KEY CHECK(id=1), installation_id text NOT NULL,
      operator_id text NOT NULL, project_id text NOT NULL, bundle_version text NOT NULL,
      phase text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await t.db.query(`
    CREATE TABLE casimir_install.maintenance(
      id text PRIMARY KEY, installation_id text NOT NULL, kind text NOT NULL,
      phase text NOT NULL, source_version text NOT NULL, target_version text,
      inventory_hash text, last_error_code text, detail jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await t.db.query(
    "INSERT INTO casimir_install.installation(id,installation_id,operator_id,project_id,bundle_version,phase) VALUES(1,$1,'casimir_test_operator',$2,'c1.0','ready')",
    [installationId, response.body.id],
  );
  return response.body.id;
}

async function waitForUploadState(db, uploadId, state) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (
      await db.query('SELECT state FROM casimir_mvp_a.uploads WHERE id=$1', [uploadId])
    ).rows[0];
    if (row?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('upload_state_timeout:' + state);
}

function beginStreamingUpload(t, path, uploadId, value) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(new URL(path + `/uploads/${uploadId}/content`, t.base), {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN,
      'Content-Length': String(value.bytes.length),
      'Content-Type': 'application/octet-stream',
    },
  });
  request.once('response', (result) => {
    const chunks = [];
    result.on('data', (chunk) => chunks.push(chunk));
    result.on('end', () =>
      resolveResponse({ status: result.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
    );
  });
  request.once('error', rejectResponse);
  request.write(value.bytes.subarray(0, 8));
  return {
    response,
    finish: () => request.end(value.bytes.subarray(8)),
  };
}

test('upload mutations are refused after the durable maintenance gate', async () => {
  await withMvpControl(
    async (t) => {
      const projectId = await project(t);
      const path = `/casimir/v1/projects/${projectId}`;
      const value = artifact();
      const created = await t.request(path + '/uploads', {
        bytes: value.bytes.length,
        sha256: value.sha256,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      await checks.beginInstallationMaintenance(
        checks.createDb(t.db),
        installationId,
        'backup',
        'c1.0',
      );

      assert.equal(
        (await t.request(path + '/uploads', { bytes: value.bytes.length, sha256: value.sha256 }))
          .status,
        409,
      );
      const content = await fetch(t.base + path + `/uploads/${created.body.uploadId}/content`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
        body: value.bytes,
      });
      assert.equal(content.status, 409);
      assert.equal((await t.request(path + `/uploads/${created.body.uploadId}/finalize`, {})).status, 409);
      assert.equal(
        (
          await t.db.query('SELECT state FROM casimir_mvp_a.uploads WHERE id=$1', [created.body.uploadId])
        ).rows[0].state,
        'staging',
      );
    },
    { installationId },
  );
});

test('an upload already streaming cannot commit after maintenance acquires the row lock', async () => {
  await withMvpControl(
    async (t) => {
      const projectId = await project(t);
      const path = `/casimir/v1/projects/${projectId}`;
      const value = artifact();
      const created = await t.request(path + '/uploads', {
        bytes: value.bytes.length,
        sha256: value.sha256,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      const sealedValue = artifact();
      const sealedUpload = await t.request(path + '/uploads', {
        bytes: sealedValue.bytes.length,
        sha256: sealedValue.sha256,
      });
      assert.equal(sealedUpload.status, 201, JSON.stringify(sealedUpload.body));
      const sealedContent = await fetch(
        t.base + path + `/uploads/${sealedUpload.body.uploadId}/content`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
          body: sealedValue.bytes,
        },
      );
      assert.equal(sealedContent.status, 200);
      const finalized = await t.request(path + `/uploads/${sealedUpload.body.uploadId}/finalize`, {});
      assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
      const sealedPath = (
        await t.db.query('SELECT path FROM casimir_mvp_a.artifacts WHERE id=$1', [finalized.body.artifactId])
      ).rows[0].path;

      const uploaded = await t.request(path + '/uploads', {
        bytes: value.bytes.length,
        sha256: value.sha256,
      });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const uploadedContent = await fetch(
        t.base + path + `/uploads/${uploaded.body.uploadId}/content`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + t.env.CASIMIR_TOKEN },
          body: value.bytes,
        },
      );
      assert.equal(uploadedContent.status, 200);
      const staged = await t.request(path + '/uploads', {
        bytes: value.bytes.length,
        sha256: value.sha256,
      });
      assert.equal(staged.status, 201, JSON.stringify(staged.body));

      const inFlight = beginStreamingUpload(t, path, created.body.uploadId, value);
      await waitForUploadState(t.db, created.body.uploadId, 'receiving');
      const maintenance = await checks.beginInstallationMaintenance(
        checks.createDb(t.db),
        installationId,
        'backup',
        'c1.0',
      );
      assert.ok(maintenance.id);
      inFlight.finish();
      assert.equal((await inFlight.response).status, 409);
      assert.equal(
        (
          await t.db.query('SELECT state FROM casimir_mvp_a.uploads WHERE id=$1', [created.body.uploadId])
        ).rows[0].state,
        'receiving',
      );

      await t.stop();
      assert.equal(t.isRunning(), false);
      await t.db.query("UPDATE casimir_install.maintenance SET phase='quiesced' WHERE id=$1", [maintenance.id]);
      const stageDir = join(t.artifactRoot, 'staging');
      await mkdir(stageDir, { recursive: true });
      await writeFile(join(stageDir, created.body.uploadId + '.gz'), 'partial');

      await checks.cancelUnfinalizedUploadsForBackup(
        checks.createDb(t.db),
        installationId,
        projectId,
        maintenance.id,
        t.artifactRoot,
      );

      for (const uploadId of [created.body.uploadId, uploaded.body.uploadId, staged.body.uploadId]) {
        assert.equal(
          (await t.db.query('SELECT state FROM casimir_mvp_a.uploads WHERE id=$1', [uploadId])).rows[0].state,
          'failed',
        );
        await assert.rejects(readFile(join(stageDir, uploadId + '.gz')), { code: 'ENOENT' });
      }
      assert.equal(
        (await t.db.query('SELECT state FROM casimir_mvp_a.uploads WHERE id=$1', [sealedUpload.body.uploadId]))
          .rows[0].state,
        'finalized',
      );
      const sealedBytes = await readFile(join(t.artifactRoot, sealedPath));
      assert.equal(createHash('sha256').update(sealedBytes).digest('hex'), sealedValue.sha256);

      await t.restart();
      for (const uploadId of [created.body.uploadId, uploaded.body.uploadId, staged.body.uploadId]) {
        assert.equal((await t.request(path + `/uploads/${uploadId}/finalize`, {})).status, 409);
      }
    },
    { installationId },
  );
});

test('stop remains available for oversized legacy history and emits preserve-all inventory', async () => {
  await withMvpControl(
    async (t) => {
      const projectId = await project(t);
      const count = 2049;
      await t.db.query(
        `INSERT INTO casimir_mvp_a.uploads(id,project_id,actor_id,bytes,sha256)
         SELECT 'upl_'||lpad(n::text,12,'0'),$1,'casimir_test_operator',1,repeat('a',64)
         FROM generate_series(1,$2) n`,
        [projectId, count],
      );
      await t.db.query(
        `INSERT INTO casimir_mvp_a.artifacts(id,upload_id,project_id,actor_id,path,bytes,sha256,manifest,runtime)
         SELECT 'car_'||lpad(n::text,12,'0'),'upl_'||lpad(n::text,12,'0'),$1,'casimir_test_operator',
                'sealed/upl_'||lpad(n::text,12,'0')||'.gz',1,repeat('a',64),'{}','{}'
         FROM generate_series(1,$2) n`,
        [projectId, count],
      );
      await t.db.query(
        `INSERT INTO deployments(id,project_id)
         SELECT 'dpl_'||lpad(n::text,12,'0'),$1 FROM generate_series(1,$2) n`,
        [projectId, count],
      );
      await t.db.query(
        `INSERT INTO casimir_mvp_a.operations(id,project_id,actor_id,artifact_id,deployment_id,idempotency_key,input_hash,runtime,phase)
         SELECT 'cmv_'||lpad(n::text,12,'0'),$1,'casimir_test_operator','car_'||lpad(n::text,12,'0'),
                'dpl_'||lpad(n::text,12,'0'),'history-'||n,repeat('b',64),'{}','succeeded'
         FROM generate_series(1,$2) n`,
        [projectId, count],
      );

      const record = await checks.beginInstallationMaintenance(
        checks.createDb(t.db),
        installationId,
        'stop',
        'c1.0',
      );
      assert.equal(record.phase, 'requested');
      const inventory = await checks.retentionInventory(checks.createDb(t.db), installationId);
      assert.equal(inventory.mode, 'preserve_all');
      assert.deepEqual(inventory.references, []);
      assert.equal(
        (await t.db.query('SELECT phase FROM casimir_install.installation WHERE id=1')).rows[0].phase,
        'maintenance',
      );
      assert.equal(
        (await t.db.query("SELECT count(*)::int AS count FROM casimir_install.maintenance WHERE installation_id=$1", [installationId])).rows[0].count,
        1,
      );
    },
    { installationId },
  );
});
