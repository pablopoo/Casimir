import { randomBytes } from 'node:crypto';
import { readFile, writeFile, open } from 'node:fs/promises';
const root = '.local/mvp-a';
const runtime = JSON.parse(await readFile('casimir/mvp-a/runner/dist/runtime.json', 'utf8'));
const imageId = process.env.CASIMIR_RUNNER_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) {
  throw new Error('runner_image');
}
await writeFile(root + '/profile.json', JSON.stringify({ runtime, artifactRoot: '/artifacts' }), {
  mode: 0o600,
});
await writeFile(root + '/runner.json', JSON.stringify({ runtime, imageId }), { mode: 0o600 });
const env = await readFile(root + '/api.env', 'utf8');
const database = env.split('\n').find((line) => line.startsWith('DATABASE_URL='));
if (!database) {
  throw new Error('database_url');
}
await writeFile(root + '/executor.env', database + '\n', { mode: 0o600 });
try {
  const fd = await open(root + '/runtime-env.json', 'wx', 0o600);
  try {
    await fd.writeFile(
      JSON.stringify({ SERVER_ONLY: 'casimir-synthetic-' + randomBytes(16).toString('hex') }),
    );
  } finally {
    await fd.close();
  }
} catch (error) {
  if (error.code !== 'EEXIST') {
    throw error;
  }
}
