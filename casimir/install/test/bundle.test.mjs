import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { verifyBundle } = await import('../bundle.mjs').catch(() => ({}));
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'casimir bundle '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const path of ['images/lifecycle.tar','images/control.tar','images/runner.tar','images/tooling.tar','images/database.tar','images/ingress.tar','sdk/void.tgz','casimir','compose.yaml','README.md','LICENSE','reference-app/package.json','templates/control.conf','sql/control.sql']) {
    await mkdir(join(root,path,'..'),{recursive:true});
    const data = Buffer.from(path); await writeFile(join(root,path),data);
    files.push({path,bytes:data.length,sha256:sha(data)});
  }
  const manifest = {format:1,version:'c1.0',sourceRevision:'a'.repeat(40),platform:'linux/amd64',runtime:{protocol:1,profile:'node-sqlite-v1',sdkVersion:'1.1.11',runtimeId:'b'.repeat(64),platform:'linux/amd64',nodeAbi:'137'},images:['lifecycle','control','runner','tooling','database','ingress'].map(role=>({role,archive:`images/${role}.tar`,sha256:sha(`images/${role}.tar`),imageId:`sha256:${'c'.repeat(64)}`,repoDigests:[]})),sdk:[{path:'sdk/void.tgz',sha256:sha('sdk/void.tgz')}],files,controlSchema:{version:1,migrationHashes:[sha('sql/control.sql')],readableBy:['c1.0']},upgradeFrom:[]};
  const save = () => writeFile(join(root,'bundle.json'),JSON.stringify(manifest));
  await save(); return {root,manifest,save};
}
test('bundle_relocates_and_has_complete_payload', async t => {
  assert.equal(typeof verifyBundle,'function','bundle verifier contract missing');
  const f=await fixture(t); assert.equal((await verifyBundle(f.root)).version,'c1.0');
  const relocated=f.root+' relocated'; await rename(f.root,relocated);
  t.after(()=>rm(relocated,{recursive:true,force:true}));
  assert.equal((await verifyBundle(relocated)).version,'c1.0');
});
test('accepts a separately catalogued third-party license notice', async t => {
  const f=await fixture(t);
  const path='THIRD_PARTY_NOTICES/remdx-theme-MIT.txt';
  const data=Buffer.from('separate MIT notice');
  await mkdir(join(f.root,path,'..'),{recursive:true});
  await writeFile(join(f.root,path),data);
  f.manifest.files.push({path,bytes:data.length,sha256:sha(data)});
  await f.save();
  assert.equal((await verifyBundle(f.root)).files.some(file=>file.path===path),true);
});
test('rejects_missing_image_or_sdk', async t => {
  const f=await fixture(t); await rm(join(f.root,'images/runner.tar'));
  await assert.rejects(()=>verifyBundle(f.root),/payload|missing/);
});
test('rejects_symlink_traversal_duplicate_and_extra_file', async t => {
  const f=await fixture(t); await writeFile(join(f.root,'extra'),'x');
  await assert.rejects(()=>verifyBundle(f.root),/payload|extra/); await rm(join(f.root,'extra'));
  f.manifest.files.push(f.manifest.files[0]); await f.save();
  await assert.rejects(()=>verifyBundle(f.root),/duplicate/); f.manifest.files.pop();
  f.manifest.files[0].path='../escape'; await f.save();
  await assert.rejects(()=>verifyBundle(f.root),/path/);
  f.manifest.files[0].path='images/lifecycle.tar'; await f.save();
  await rm(join(f.root,'sdk/void.tgz')); await symlink('/etc/passwd',join(f.root,'sdk/void.tgz'));
  await assert.rejects(()=>verifyBundle(f.root),/regular|link/);
});
test('rejects_tampered_bytes_and_unknown_manifest_fields', async t => {
  const f=await fixture(t); await writeFile(join(f.root,'casimir'),'tampered');
  await assert.rejects(()=>verifyBundle(f.root),/hash|size/);
  f.manifest.command='sh'; await f.save(); await assert.rejects(()=>verifyBundle(f.root),/fields/);
});
test('rejects_catalog_without_runtime_sql_or_reference_app', async t => {
  const f=await fixture(t);
  for(const path of ['sql/control.sql','reference-app/package.json']) {
    f.manifest.files=f.manifest.files.filter(x=>x.path!==path); await rm(join(f.root,path));
  }
  await f.save(); await assert.rejects(()=>verifyBundle(f.root),/missing payload/);
});
