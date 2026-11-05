import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const version = process.env.CASIMIR_DEMO_VERSION;
const projectId = process.env.CASIMIR_PROJECT_ID;
const deploymentId = process.env.CASIMIR_DEPLOYMENT_ID;
const readonly = process.env.CASIMIR_MODE === 'read-only';
const db = new DatabaseSync((process.env.CASIMIR_DATA_DIR ?? '/data') + '/app.sqlite', {
  readOnly: readonly,
});
function bound() {
  const r = db.prepare('SELECT * FROM casimir_metadata').all();
  return (
    r.length === 1 &&
    r[0].scope === 'casimir-execution-poc' &&
    r[0].project_id === projectId &&
    r[0].recipe_version === 1
  );
}
const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!bound()) return send(503, { error: 'data binding mismatch' });
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/version'))
      return send(version === 'broken' ? 503 : 200, {
        version,
        deploymentId,
        projectId,
        writable: !readonly,
      });
    if (req.method === 'GET' && req.url.startsWith('/records/')) {
      const id = decodeURIComponent(req.url.slice(9));
      const row = db.prepare('SELECT id,value FROM records WHERE id=?').get(id);
      return send(row ? 200 : 404, row ?? { error: 'record not found' });
    }
    if (req.method === 'POST' && req.url === '/records') {
      if (readonly) return send(403, { error: 'read-only preflight' });
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) {
          send(413, { error: 'body too large' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'invalid record' });
      }
      if (
        !value ||
        Object.keys(value).sort().join(',') !== 'id,value' ||
        typeof value.id !== 'string' ||
        !value.id.length ||
        value.id.length > 128 ||
        typeof value.value !== 'string'
      )
        return send(400, { error: 'invalid record' });
      const old = db.prepare('SELECT id,value FROM records WHERE id=?').get(value.id);
      if (old) return send(old.value === value.value ? 200 : 409, old);
      db.prepare('INSERT INTO records(id,value) VALUES (?,?)').run(value.id, value.value);
      return send(201, value);
    }
    send(404, { error: 'not found' });
  } catch {
    send(503, { error: 'app unavailable' });
  }
});
server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
process.on('SIGTERM', () =>
  server.close(() => {
    db.close();
  }),
);
