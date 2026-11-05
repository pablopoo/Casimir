import assert from 'node:assert/strict';
import {lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {stageRelease} from '../stage-release.mjs';

test('stages selected runtime trees and excludes workspace and test baggage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'c1-stage-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source');
  const release = join(root, 'release');
  await mkdir(join(source, 'casimir/install/test'), {recursive: true});
  await mkdir(join(source, 'casimir/install/runtime'), {recursive: true});
  await mkdir(join(source, 'platform/packages/api/src/admin/react/themes'), {recursive: true});
  await mkdir(join(source, 'node_modules/private-cache'), {recursive: true});
  await writeFile(join(source, 'casimir/install/runtime/cli.mjs'), "import './helper.mjs';\n");
  await writeFile(join(source, 'casimir/install/runtime/helper.mjs'), 'export const ready = true;\n');
  await writeFile(join(source, 'platform/packages/api/src/admin/react/themes/LICENSE'), 'theme license notice\n');
  await writeFile(join(source, 'casimir/install/test/fixture.mjs'), 'never ship tests\n');
  await writeFile(join(source, 'node_modules/private-cache/index.js'), 'never ship cache\n');

  await stageRelease({
    sourceRoot: source,
    destinationRoot: release,
    entries: ['casimir/install', 'platform/packages/api/src'],
  });

  assert.match(await readFile(join(release, 'casimir/install/runtime/helper.mjs'), 'utf8'), /ready/);
  assert.equal(
    await readFile(join(release, 'platform/packages/api/src/admin/react/themes/LICENSE'), 'utf8'),
    'theme license notice\n',
  );
  await assert.rejects(readFile(join(release, 'casimir/install/test/fixture.mjs')),
    {code: 'ENOENT'});
  await assert.rejects(readFile(join(release, 'node_modules/private-cache/index.js')),
    {code: 'ENOENT'});
});

test('keeps the package lock and reference app while excluding build-only staging metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'c1-stage-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source');
  const release = join(root, 'release');
  await mkdir(join(source, 'casimir/install/runtime-deps'), {recursive: true});
  await mkdir(join(source, 'casimir/examples/notes'), {recursive: true});
  await writeFile(join(source, 'casimir/install/consumer-pnpm-lock.yaml'), 'frozen consumer lock\n');
  await writeFile(join(source, 'casimir/install/package.mjs'), 'export const pack = true;\n');
  await writeFile(join(source, 'casimir/install/runtime-deps/package.json'), 'preparation-only\n');
  await writeFile(join(source, 'casimir/install/stage-release.mjs'), 'builder-only\n');
  await writeFile(join(source, 'casimir/examples/notes/package.json'), '{"name":"reference-app"}\n');

  await stageRelease({
    sourceRoot: source,
    destinationRoot: release,
    entries: ['casimir/install', 'casimir/examples/notes'],
  });

  assert.equal(
    await readFile(join(release, 'casimir/install/consumer-pnpm-lock.yaml'), 'utf8'),
    'frozen consumer lock\n',
  );
  assert.equal(
    await readFile(join(release, 'casimir/install/package.mjs'), 'utf8'),
    'export const pack = true;\n',
  );
  assert.equal(
    await readFile(join(release, 'casimir/examples/notes/package.json'), 'utf8'),
    '{"name":"reference-app"}\n',
  );
  await assert.rejects(readFile(join(release, 'casimir/install/runtime-deps/package.json')), {code: 'ENOENT'});
  await assert.rejects(readFile(join(release, 'casimir/install/stage-release.mjs')), {code: 'ENOENT'});
});

test('rejects a selected symlink that escapes the source before writing release files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'c1-stage-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source');
  const release = join(root, 'release');
  await mkdir(join(source, 'runtime'), {recursive: true});
  await writeFile(join(root, 'private.txt'), 'must stay outside the release');
  await symlink(join(root, 'private.txt'), join(source, 'runtime/private.txt'));

  await assert.rejects(
    stageRelease({sourceRoot: source, destinationRoot: release, entries: ['runtime']}),
    {code: 'release_path_escapes_source'},
  );
  await assert.rejects(readFile(join(release, 'runtime/private.txt')), {code: 'ENOENT'});
});

test('materializes an in-root link target outside selected entries instead of shipping a broken link', async t => {
  const root = await mkdtemp(join(tmpdir(), 'c1-stage-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source');
  const release = join(root, 'release');
  await mkdir(join(source, 'runtime'), {recursive: true});
  await mkdir(join(source, 'unstaged', 'pkg'), {recursive: true});
  await writeFile(join(source, 'runtime/main.mjs'), "import './linked-pkg/package.json';\n");
  await writeFile(join(source, 'unstaged/pkg/package.json'), '{"name":"runtime-dependency"}\n');
  await symlink('../unstaged/pkg', join(source, 'runtime/linked-pkg'));

  await stageRelease({sourceRoot: source, destinationRoot: release, entries: ['runtime']});

  assert.equal(
    await readFile(join(release, 'runtime/linked-pkg/package.json'), 'utf8'),
    '{"name":"runtime-dependency"}\n',
  );
  assert.notEqual((await lstat(join(release, 'runtime/linked-pkg'))).isSymbolicLink(), true);
  await assert.rejects(readFile(join(release, 'unstaged/pkg/package.json')), {code: 'ENOENT'});
});

test('fails on a missing required entry before creating destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'c1-stage-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source');
  const release = join(root, 'release');
  await mkdir(source);

  await assert.rejects(
    stageRelease({sourceRoot: source, destinationRoot: release, entries: ['required/runtime.mjs']}),
    {code: 'release_required_path_missing'},
  );
  await assert.rejects(readFile(release), {code: 'ENOENT'});
});
