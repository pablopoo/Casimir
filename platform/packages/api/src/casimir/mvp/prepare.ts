import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertCasimirRuntime,
  canonicalJson,
  parseCasimirManifest,
  type CasimirManifest,
} from '@void/deploy-core';
import { sql } from 'drizzle-orm';
import { extractCasimirArtifact } from '../../../../../../packages/void/src/casimir/artifact-codec.ts';
import type { Db } from '../../db/client.ts';
import type { ExecutorGuard } from '../execution/guard.ts';
import { lockMvpProject, mapMvpOperation } from './store.ts';
import type { MvpArtifact, MvpOperation, MvpProfile } from './types.ts';

export interface ArtifactImageEngine {
  buildArtifact(directory: string, manifest: CasimirManifest, op: MvpOperation): Promise<string>;
  inspectPreparedImage(id: string, op: MvpOperation): Promise<void>;
}
export type MvpPreparationContext = {
  db: Db;
  guard: ExecutorGuard;
  engine: ArtifactImageEngine;
  profile: MvpProfile;
  artifactRoot: string;
};
export async function prepareArtifactImage(
  ctx: MvpPreparationContext,
  op: MvpOperation,
): Promise<string> {
  ctx.guard.assertLive();
  assertCasimirRuntime(op.runtime, ctx.profile.runtime);
  const prepared = await ctx.db.transaction(async (tx) => {
    await lockMvpProject(tx, op.actor_id, op.project_id);
    const rows = await tx.execute(
      sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${op.id} FOR UPDATE`,
    );
    const current = mapMvpOperation(rows.rows[0]);
    if (
      current.artifact_id !== op.artifact_id ||
      current.project_id !== op.project_id ||
      current.actor_id !== op.actor_id
    ) {
      throw new Error('operation_changed');
    }
    const prior = await tx.execute<{ state: string; image_id: string | null }>(
      sql`SELECT * FROM casimir_mvp_a.preparations WHERE operation_id=${op.id} FOR UPDATE`,
    );
    if (prior.rows[0]?.state === 'prepared' && prior.rows[0].image_id) {
      return prior.rows[0].image_id;
    }
    if (!['queued', 'preparing'].includes(current.phase)) {
      throw new Error('preparation_phase');
    }
    await tx.execute(
      sql`UPDATE casimir_mvp_a.operations SET phase='preparing',updated_at=now() WHERE id=${op.id}`,
    );
    await tx.execute(
      sql`INSERT INTO casimir_mvp_a.preparations(id,operation_id,state) VALUES(${op.id},${op.id},'building') ON CONFLICT(operation_id) DO NOTHING`,
    );
    return null;
  });
  if (prepared) {
    await ctx.engine.inspectPreparedImage(prepared, op);
    return prepared;
  }
  ctx.guard.assertLive();
  const rows = await ctx.db.execute<MvpArtifact>(
    sql`SELECT * FROM casimir_mvp_a.artifacts WHERE id=${op.artifact_id} AND project_id=${op.project_id} AND actor_id=${op.actor_id}`,
  );
  const artifact = rows.rows[0];
  if (!artifact || !/^sealed\/upl_[a-z0-9]{12}\.gz$/.test(artifact.path)) {
    throw new Error('artifact_invalid');
  }
  const manifest = parseCasimirManifest(artifact.manifest);
  assertCasimirRuntime(manifest, ctx.profile.runtime);
  const work = join(ctx.artifactRoot, 'work');
  await mkdir(work, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(work, 'prepare-'));
  try {
    const directory = join(temp, 'payload');
    const decoded = await extractCasimirArtifact(
      join(ctx.artifactRoot, artifact.path),
      directory,
      ctx.profile.runtime,
    );
    if (
      decoded.sha256 !== artifact.sha256 ||
      canonicalJson(decoded.manifest) !== canonicalJson(manifest)
    ) {
      throw new Error('artifact_changed');
    }
    ctx.guard.assertLive();
    const image = await ctx.engine.buildArtifact(directory, manifest, op);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error('image_identity');
    }
    await ctx.engine.inspectPreparedImage(image, op);
    ctx.guard.assertLive();
    await ctx.db.transaction(async (tx) => {
      await lockMvpProject(tx, op.actor_id, op.project_id);
      await tx.execute(
        sql`UPDATE casimir_mvp_a.preparations SET state='prepared',image_id=${image} WHERE operation_id=${op.id} AND state='building'`,
      );
      await tx.execute(
        sql`UPDATE casimir_mvp_a.operations SET image_id=${image},updated_at=now() WHERE id=${op.id} AND phase='preparing'`,
      );
    });
    return image;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
