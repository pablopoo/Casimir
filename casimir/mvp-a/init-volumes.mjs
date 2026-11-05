import { mkdir, chown, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { MvpRouteStore } from '../dist/checks.mjs';
await mkdir('/routes', { recursive: true });
await chown('/routes', 0, 0);
await new MvpRouteStore('/routes').initialize();
await chown('/routes/route.conf', 1000, 1000);
await mkdir('/data', { recursive: true });
try {
  const file = await lstat('/data/app.sqlite');
  if (!file.isFile()) {
    throw new Error('data_file_invalid');
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
  await chown('/data', 0, 0);
  const Database = createRequire('/src/packages/void/package.json')('better-sqlite3');
  const database = new Database('/data/app.sqlite');
  database.close();
}
await chown('/data/app.sqlite', 1000, 1000);
for (const path of ['/artifacts', '/runtime', '/jobs', '/snapshots', '/data', '/routes']) {
  await mkdir(path, { recursive: true });
  await chown(path, 1000, 1000);
}
