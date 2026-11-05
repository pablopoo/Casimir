import { existsSync, mkdirSync, chownSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const dir = process.env.CASIMIR_DATA_DIR ?? '/data';
const project = process.env.CASIMIR_PROJECT_ID;
try {
  if (!/^proj_[a-z0-9]{12}$/.test(project ?? '')) throw Error();
  mkdirSync(dir, { recursive: true });
  const path = dir + '/app.sqlite',
    existed = existsSync(path);
  const db = new DatabaseSync(path);
  try {
    if (existed) {
      const row = db.prepare('SELECT scope,project_id,recipe_version FROM casimir_metadata').get();
      if (
        row?.scope !== 'casimir-execution-poc' ||
        row.project_id !== project ||
        row.recipe_version !== 1
      )
        throw Error();
      db.prepare('SELECT id,value FROM records LIMIT 1').all();
    } else {
      db.exec(
        'PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; CREATE TABLE casimir_metadata(scope TEXT NOT NULL,project_id TEXT NOT NULL,recipe_version INTEGER NOT NULL); CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT NOT NULL);',
      );
      db.prepare('INSERT INTO casimir_metadata VALUES (?,?,1)').run(
        'casimir-execution-poc',
        project,
      );
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
  if (process.getuid() === 0) {
    chownSync(path, 1000, 1000);
    chownSync(dir, 1000, 1000);
  }
  console.log('App data binding verified');
} catch {
  console.error('App data binding invalid');
  process.exitCode = 1;
}
