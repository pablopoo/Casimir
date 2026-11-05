import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path/posix';

const destination = resolve(process.argv[2] ?? '.local/mvp-a/sdk');
mkdirSync(destination, { recursive: true });
const packages = new Map();
for (const entry of readdirSync('packages', { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  try {
    const path = join('packages', entry.name);
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    packages.set(pkg.name, { path, pkg });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}
const packed = {};
function pack(name) {
  if (packed[name]) {
    return;
  }
  const found = packages.get(name);
  if (!found) {
    throw new Error(`Missing local package ${name}`);
  }
  for (const [dependency, spec] of Object.entries(found.pkg.dependencies ?? {})) {
    if (spec.startsWith('workspace:')) {
      pack(dependency);
    }
  }
  execFileSync('pnpm', ['--dir', found.path, 'pack', '--pack-destination', destination], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const filename = `${name.replace('@', '').replace('/', '-')}-${found.pkg.version}.tgz`;
  const path = join(destination, filename);
  packed[name] = {
    filename,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
pack('void');
pack('@void/react');
writeFileSync(join(destination, 'catalog.json'), JSON.stringify(packed, null, 2) + '\n');
console.log(`Packed ${Object.keys(packed).length} local SDK packages`);
