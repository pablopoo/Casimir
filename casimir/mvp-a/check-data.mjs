import Database from '/runner/node_modules/better-sqlite3/lib/index.js';
const db = new Database('/data/app.sqlite', { readonly: true, fileMustExist: true });
try {
  console.log(
    JSON.stringify({
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
      migrations: db.prepare('SELECT * FROM __casimir_migrations ORDER BY name').all(),
      batches: db.prepare('SELECT * FROM __casimir_batches ORDER BY fingerprint').all(),
      schema: db
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all(),
    }),
  );
} finally {
  db.close();
}
