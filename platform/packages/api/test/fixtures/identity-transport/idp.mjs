import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { gzipSync } from 'node:zlib';

const [keyPath = '/work/idp-key.pem', certificatePath = '/work/idp-cert.pem', logPath = '/work/idp-requests.log'] = process.argv.slice(2);
let requestCount = 0;
const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certificatePath) },
  (request, response) => {
    requestCount++;
    const pathname = new URL(request.url ?? '/', 'https://idp.example.com').pathname;
    appendFileSync(logPath, `${requestCount} ${request.method ?? 'GET'} ${pathname}\n`);
    response.on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
    });

    if (pathname === '/probe') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ requestCount }));
      return;
    }
    if (pathname === '/redirect') {
      response.writeHead(302, { location: '/probe' });
      response.end();
      return;
    }
    if (pathname === '/raw') {
      const body = Buffer.alloc(300 * 1024, 0x52);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.byteLength),
      });
      response.end(body);
      return;
    }
    if (pathname === '/chunked') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write(Buffer.alloc(128 * 1024, 0x43));
      response.write(Buffer.alloc(128 * 1024 + 1, 0x44));
      response.end();
      return;
    }
    if (pathname === '/gzip') {
      const body = gzipSync(Buffer.alloc(512 * 1024, 0x47));
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length': String(body.byteLength),
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  },
);

server.listen(443, '0.0.0.0', () => process.stdout.write('READY\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
