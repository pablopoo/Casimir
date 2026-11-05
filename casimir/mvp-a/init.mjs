import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path/posix';
const root = process.argv[2];
if (!root) {
  throw new Error('private configuration directory required');
}
mkdirSync(root, { recursive: true, mode: 0o700 });
const db = join(root, 'db.env'),
  api = join(root, 'api.env');
if (existsSync(db) !== existsSync(api)) {
  throw new Error('partial credentials require operator repair');
}
if (!existsSync(db)) {
  const password = randomBytes(24).toString('hex'),
    token = randomBytes(32).toString('hex');
  writeFileSync(
    db,
    `POSTGRES_USER=casimir_mvp_a\nPOSTGRES_DB=casimir_mvp_a\nPOSTGRES_PASSWORD=${password}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    api,
    `DATABASE_URL=postgresql://casimir_mvp_a:${password}@casimir-mvp-a-db:5432/casimir_mvp_a\nCASIMIR_OPERATOR_ID=casimir_test_operator\nCASIMIR_TOKEN=${token}\nPORT=3000\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
const executor = join(root, 'executor.env');
const executorEnv =
  readFileSync(api, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('DATABASE_URL=')) + '\n';
if (!existsSync(executor)) {
  writeFileSync(executor, executorEnv, { flag: 'wx', mode: 0o600 });
} else if (readFileSync(executor, 'utf8') !== executorEnv) {
  throw new Error('executor database configuration mismatch');
}
console.log('Private increment A credentials retained/prepared');
