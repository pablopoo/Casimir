import { createHash } from 'node:crypto';
import { constants, createWriteStream, createReadStream } from 'node:fs';
import { mkdir, open, copyFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CASIMIR_LIMITS } from '@void/deploy-core';
import { sql } from 'drizzle-orm';
import { extractCasimirArtifact } from '../../../../../../packages/void/src/casimir/artifact-codec.ts';
import type { Db } from '../../db/client.ts';
import { generateId } from '../../id.ts';
import { LocalHttpError } from '../project-service.ts';
import { lockMvpProject } from './store.ts';
import type { MvpProfile } from './types.ts';
import {assertAdmissionCapacity} from '../lifecycle/capacity.ts';
import { assertInstallationAdmission } from '../lifecycle/maintenance.ts';
type Upload = {
  id: string;
  project_id: string;
  actor_id: string;
  bytes: string;
  sha256: string;
  state: string;
  expires_at: string | Date;
};
async function syncDir(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function createMvpUpload(
  db: Db,
  profile: MvpProfile,
  actorId: string,
  projectId: string,
  bytes: unknown,
  sha256: unknown,
): Promise<{ uploadId: string }> {
  if (
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > CASIMIR_LIMITS.compressed ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new LocalHttpError(400, 'invalid upload declaration');
  }
  return db.transaction(async (tx) => {
    if (profile.installationId) await assertInstallationAdmission(tx, profile.installationId);
    await lockMvpProject(tx, actorId, projectId);
    const id = generateId('upl');
    await tx.execute(
      sql`INSERT INTO casimir_mvp_a.uploads(id,project_id,actor_id,bytes,sha256) VALUES(${id},${projectId},${actorId},${bytes},${sha256})`,
    );
    return { uploadId: id };
  });
}
export async function receiveMvpUpload(
  db: Db,
  profile: MvpProfile,
  actorId: string,
  projectId: string,
  id: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  await assertAdmissionCapacity(profile);
  const upload = await db.transaction(async (tx) => {
    if (profile.installationId) await assertInstallationAdmission(tx, profile.installationId);
    await lockMvpProject(tx, actorId, projectId);
    const result = await tx.execute<Upload>(
      sql`SELECT * FROM casimir_mvp_a.uploads WHERE id=${id} AND actor_id=${actorId} AND project_id=${projectId} FOR UPDATE`,
    );
    const value = result.rows[0];
    if (!value) {
      throw new LocalHttpError(404, 'upload not found');
    }
    if (value.state !== 'staging' || new Date(value.expires_at).getTime() <= Date.now()) {
      throw new LocalHttpError(409, 'upload not writable');
    }
    await tx.execute(sql`UPDATE casimir_mvp_a.uploads SET state='receiving' WHERE id=${id}`);
    return value;
  });
  const staging = join(profile.artifactRoot, 'staging');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const path = join(staging, upload.id + '.gz');
  let count = 0;
  const hash = createHash('sha256');
  try {
    if (!body) {
      throw new LocalHttpError(400, 'missing upload bytes');
    }
    await pipeline(
      Readable.fromWeb(body as never),
      new Transform({
        transform(chunk: Buffer, _e, callback) {
          count += chunk.length;
          if (count > Number(upload.bytes) || count > CASIMIR_LIMITS.compressed) {
            return callback(new LocalHttpError(413, 'upload exceeds declared size'));
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    );
    if (count !== Number(upload.bytes) || hash.digest('hex') !== upload.sha256) {
      throw new LocalHttpError(400, 'upload digest or size mismatch');
    }
    const file = await open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDir(staging);
    await db.transaction(async (tx) => {
      if (profile.installationId) await assertInstallationAdmission(tx, profile.installationId);
      await lockMvpProject(tx, actorId, projectId);
      const result = await tx.execute(
        sql`UPDATE casimir_mvp_a.uploads SET state='uploaded' WHERE id=${id} AND state='receiving' AND expires_at>now() RETURNING id`,
      );
      if (!result.rows.length) {
        throw new LocalHttpError(409, 'upload expired or changed');
      }
    });
  } catch (error) {
    await rm(path, { force: true });
    await db
      .transaction(async (tx) => {
        if (profile.installationId) await assertInstallationAdmission(tx, profile.installationId);
        await lockMvpProject(tx, actorId, projectId);
        await tx.execute(
          sql`UPDATE casimir_mvp_a.uploads SET state='failed' WHERE id=${id} AND state='receiving'`,
        );
      })
      .catch(() => {});
    throw error;
  }
}
async function digestFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
export async function finalizeMvpUpload(
  db: Db,
  profile: MvpProfile,
  actorId: string,
  projectId: string,
  id: string,
): Promise<{ artifactId: string }> {
  return db.transaction(async (tx) => {
    // The singleton lock bounds concurrent decoding and protects ownership changes.
    if (profile.installationId) await assertInstallationAdmission(tx, profile.installationId);
    await lockMvpProject(tx, actorId, projectId);
    const result = await tx.execute<Upload>(
      sql`SELECT * FROM casimir_mvp_a.uploads WHERE id=${id} AND actor_id=${actorId} AND project_id=${projectId} FOR UPDATE`,
    );
    const upload = result.rows[0];
    if (!upload) {
      throw new LocalHttpError(404, 'upload not found');
    }
    const prior = await tx.execute<{ id: string }>(
      sql`SELECT id FROM casimir_mvp_a.artifacts WHERE upload_id=${id} AND actor_id=${actorId} AND project_id=${projectId}`,
    );
    if (prior.rows[0]) {
      return { artifactId: prior.rows[0].id };
    }
    if (upload.state !== 'uploaded' || new Date(upload.expires_at).getTime() <= Date.now()) {
      throw new LocalHttpError(409, 'upload incomplete or expired');
    }
    const stage = join(profile.artifactRoot, 'staging', upload.id + '.gz'),
      checked = join(profile.artifactRoot, 'validation', upload.id);
    let decoded;
    try {
      await rm(checked, { recursive: true, force: true });
      decoded = await extractCasimirArtifact(stage, checked, profile.runtime);
    } catch {
      throw new LocalHttpError(400, 'invalid native artifact');
    } finally {
      await rm(checked, { recursive: true, force: true });
    }
    if (decoded.sha256 !== upload.sha256) {
      throw new LocalHttpError(400, 'artifact digest mismatch');
    }
    const sealed = join(profile.artifactRoot, 'sealed');
    await mkdir(sealed, { recursive: true, mode: 0o700 });
    const relative = 'sealed/' + upload.id + '.gz',
      path = join(profile.artifactRoot, relative);
    try {
      await copyFile(stage, path, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if ((await digestFile(path)) !== upload.sha256) {
        throw new Error('sealed artifact collision');
      }
    }
    await chmod(path, 0o400);
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDir(sealed);
    await syncDir(profile.artifactRoot);
    const artifactId = generateId('car');
    await tx.execute(
      sql`INSERT INTO casimir_mvp_a.artifacts(id,upload_id,actor_id,project_id,path,bytes,sha256,manifest,runtime) VALUES(${artifactId},${id},${actorId},${projectId},${relative},${Number(upload.bytes)},${upload.sha256},${JSON.stringify(decoded.manifest)}::jsonb,${JSON.stringify(profile.runtime)}::jsonb)`,
    );
    await tx.execute(sql`UPDATE casimir_mvp_a.uploads SET state='finalized' WHERE id=${id}`);
    return { artifactId };
  });
}
/** Expiry removes only named task staging/orphans, never a referenced artifact. */
export async function expireMvpUploads(db: Db, profile: MvpProfile): Promise<number> {
  return (await expireMvpUploadBatch(db,profile)).count;
}
export async function expireMvpUploadBatch(db:Db,profile:MvpProfile,cursor='',assertLive:()=>void=()=>{}):Promise<{count:number;cursor:string}>{
  if(cursor&&!/^upl_[a-z0-9]{12}$/.test(cursor))throw new Error('upload_expiry_cursor');
  assertLive();
  return db.transaction(async (tx) => {
    if(profile.installationId){
      const installation=await tx.execute<{installation_id:string;phase:string}>(sql`SELECT installation_id,phase FROM casimir_install.installation WHERE id=1 FOR UPDATE`);
      if(installation.rows[0]?.installation_id!==profile.installationId)throw new Error('installation_identity');
      if(installation.rows[0].phase!=='ready')return {count:0,cursor};
    }
    await tx.execute(sql`SELECT id FROM casimir_mvp_a.scope WHERE id=1 FOR UPDATE`);
    const expired = await tx.execute<{ id: string }>(
      sql`SELECT id FROM casimir_mvp_a.uploads WHERE expires_at<now() AND id>${cursor} ORDER BY id LIMIT 100 FOR UPDATE`,
    );
    for (const { id } of expired.rows) {
      if (!/^upl_[a-z0-9]{12}$/.test(id)) {
        throw new Error('invalid upload journal');
      }
      assertLive();await rm(join(profile.artifactRoot, 'staging', id + '.gz'), { force: true });
      const referenced = await tx.execute(
        sql`SELECT id FROM casimir_mvp_a.artifacts WHERE upload_id=${id}`,
      );
      if (!referenced.rows.length) {
        assertLive();await rm(join(profile.artifactRoot, 'sealed', id + '.gz'), { force: true });
      }
      assertLive();await rm(join(profile.artifactRoot, 'validation', id), { recursive: true, force: true });
    }
    return {count:expired.rows.length,cursor:expired.rows.at(-1)?.id??''};
  });
}
