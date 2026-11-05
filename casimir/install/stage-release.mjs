import {chmod, copyFile, lstat, mkdir, readdir, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const releaseEntries = [
  'LICENSE',
  'casimir/dist',
  'casimir/install',
  'casimir/migrate.mjs',
  'casimir/seed.mjs',
  'casimir/mvp-a/init-volumes.mjs',
  'casimir/mvp-a/migrate.mjs',
  'casimir/mvp-a/migrations',
  'casimir/mvp-a/runner/dist',
  'casimir/examples/notes',
  'platform/packages/api/package.json',
  'platform/packages/api/drizzle',
  'platform/packages/api/src',
  'packages/void/package.json',
  'packages/void/src/casimir',
  'packages/void/src/shared/module-references.ts',
  'packages/deploy-core/package.json',
  'packages/deploy-core/dist',
];

const excludedDirectories = new Set([
  '.git',
  '.local',
  '.void',
  '__tests__',
  'node_modules',
  'runtime-deps',
  'test',
  'tests',
]);

const excludedFiles = new Set([
  'clean-source.mjs',
  'provenance.json',
  'stage-release.mjs',
]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function shouldSkip(path) {
  const parts = path.split(sep);
  return parts.some(part => excludedDirectories.has(part)) || excludedFiles.has(parts.at(-1)) ||
    parts.at(-1) === 'Dockerfile' || parts.at(-1).endsWith('.dockerignore') ||
    /^\w+\.Dockerfile$/.test(parts.at(-1)) ||
    (parts[0] === 'casimir' && parts[1] === 'install' && parts[2] === 'sdk');
}

function safeRelativeEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0 || isAbsolute(entry)) return false;
  const parts = entry.split(/[\\/]/);
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}

export async function stageRelease({sourceRoot, destinationRoot, entries = releaseEntries}) {
  const source = await realpath(sourceRoot);
  const destination = resolve(destinationRoot);
  if (within(source, destination) || within(destination, source)) throw failure('release_paths_overlap');
  if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry => !safeRelativeEntry(entry))) {
    throw failure('release_entries_invalid');
  }
  try {
    await lstat(destination);
    throw failure('release_destination_exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const files = new Map();
  async function collect(sourcePath, releasePath, ancestors = new Set()) {
    const sourceRelative = relative(source, sourcePath);
    if (!within(source, sourcePath)) throw failure('release_path_escapes_source');
    if (sourceRelative && shouldSkip(sourceRelative)) return;

    let info = await lstat(sourcePath).catch(error => {
      if (error.code === 'ENOENT') throw failure('release_required_path_missing');
      throw error;
    });
    let resolvedPath = sourcePath;
    if (info.isSymbolicLink()) {
      resolvedPath = await realpath(sourcePath);
      if (!within(source, resolvedPath)) throw failure('release_path_escapes_source');
      info = await stat(resolvedPath);
    }

    if (info.isDirectory()) {
      const real = await realpath(resolvedPath);
      if (ancestors.has(real)) throw failure('release_symlink_cycle');
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(real);
      for (const name of (await readdir(resolvedPath)).sort()) {
        const childPath = join(sourcePath, name);
        const childReleasePath = join(releasePath, name);
        await collect(childPath, childReleasePath, nextAncestors);
      }
      return;
    }
    if (!info.isFile()) throw failure('release_special_file_unsupported');
    if (files.has(releasePath)) throw failure('release_destination_path_duplicate');
    files.set(releasePath, {sourcePath: resolvedPath, mode: info.mode & 0o777});
  }

  for (const entry of entries) {
    await collect(join(source, entry), entry);
  }
  if (files.size === 0) throw failure('release_no_files_selected');

  await mkdir(destination, {recursive: true});
  for (const [releasePath, file] of files) {
    const outputPath = join(destination, releasePath);
    await mkdir(dirname(outputPath), {recursive: true});
    await copyFile(file.sourcePath, outputPath);
    await chmod(outputPath, file.mode);
  }
  return {files: files.size};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourceRoot, destinationRoot, ...extra] = process.argv.slice(2);
  if (!sourceRoot || !destinationRoot || extra.length > 0) {
    console.error('usage: node casimir/install/stage-release.mjs SOURCE_ROOT DESTINATION_ROOT');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await stageRelease({sourceRoot, destinationRoot})));
    } catch (error) {
      console.error(error.code ?? 'release_stage_failed');
      process.exitCode = 1;
    }
  }
}
