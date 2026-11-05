import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createAuthSetupFetch } from '../auth-transport.mjs';

const SETUP_PATH = '/internal/platform/auth-initialize';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SYNTHETIC_SETUP_TOKEN = 'synthetic-auth-setup-token-for-tests-only';
const INSTALLATION_ID = '0123456789abcdef0123456789abcdef';
const SCOPE = `casimir-${INSTALLATION_ID}`;
const NATIVE_INGRESS_PORT = 8080;
const DNS_ORIGIN = `https://control.example.test:4485`;

setDefaultResultOrder('ipv4first');

let certificateDirectory;
let certificates;

function openssl(args) {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function createCertificateAuthority(prefix, commonName) {
  const keyPath = join(certificateDirectory, `${prefix}-ca.key`);
  const certificatePath = join(certificateDirectory, `${prefix}-ca.pem`);
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certificatePath, '-days', '2',
    '-subj', `/CN=${commonName}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  return { keyPath, certificatePath };
}

function createServerCertificate(prefix, commonName, subjectAltName, authority) {
  const keyPath = join(certificateDirectory, `${prefix}.key`);
  const requestPath = join(certificateDirectory, `${prefix}.csr`);
  const certificatePath = join(certificateDirectory, `${prefix}.pem`);
  const extensionsPath = join(certificateDirectory, `${prefix}.ext`);
  openssl([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', requestPath,
    '-subj', `/CN=${commonName}`,
  ]);
  return writeFile(extensionsPath, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${subjectAltName}`,
    '',
  ].join('\n')).then(() => {
    openssl([
      'x509', '-req', '-in', requestPath,
      '-CA', authority.certificatePath, '-CAkey', authority.keyPath,
      '-CAcreateserial', '-out', certificatePath, '-days', '2', '-sha256',
      '-extfile', extensionsPath,
    ]);
    return { key: readFile(keyPath), certificate: readFile(certificatePath) };
  });
}

before(async () => {
  certificateDirectory = await mkdtemp(join(tmpdir(), 'casimir-auth-transport-'));
  const authority = createCertificateAuthority('trusted', 'Casimir Synthetic Test CA');
  const otherAuthority = createCertificateAuthority('other', 'Untrusted Synthetic Test CA');
  const valid = await createServerCertificate(
    'valid-control',
    'control.example.test',
    'DNS:control.example.test,DNS:localhost',
    authority,
  );
  const wrongHostname = await createServerCertificate(
    'wrong-host',
    'wrong.example.test',
    'DNS:wrong.example.test',
    authority,
  );
  certificates = {
    ca: await readFile(authority.certificatePath),
    wrongCa: await readFile(otherAuthority.certificatePath),
    valid,
    wrongHostname,
  };
});

after(async () => {
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

async function startHttpsServer({ key, certificate, host = '127.0.0.1', port = 0, onRequest }) {
  const server = createServer({ key, cert: certificate }, (request, response) => {
    void onRequest(request, response);
  });
  // Failed certificate checks are expected in two cases below. The client
  // assertion is the TLS result; this listener prevents server-side noise.
  server.on('tlsClientError', () => {});
  server.listen(port, host);
  await once(server, 'listening');
  return server;
}

async function closeHttpsServer(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function makeInspectingEngine({ hostPort, address = '127.0.0.1' }) {
  const inspected = [];
  return {
    inspected,
    engine: {
      scope: SCOPE,
      async inspectContainer(name) {
        inspected.push(name);
        return {
          State: { Running: true },
          Config: { Labels: { 'org.casimir.installation': INSTALLATION_ID } },
          NetworkSettings: {
            Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
            Networks: { [`${SCOPE}-front`]: { IPAddress: address } },
          },
        };
      },
    },
  };
}

function validRequest(body = '{}', overrides = {}) {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      'x-void-auth-setup': createHmac('sha256', SYNTHETIC_SETUP_TOKEN)
        .update(body, 'utf8')
        .digest('base64url'),
    },
    body,
    ...overrides,
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function newRequestRecorder() {
  const records = [];
  let responseMode = 'ok';
  let redirectTargetRequests = 0;
  return {
    records,
    setResponseMode(mode) { responseMode = mode; },
    get redirectTargetRequests() { return redirectTargetRequests; },
    async handle(request, response) {
      if (request.url === '/redirect-target') {
        redirectTargetRequests++;
        response.writeHead(200).end('must not be followed');
        return;
      }
      const body = await readBody(request);
      records.push({
        method: request.method,
        path: request.url,
        host: request.headers.host,
        servername: request.socket.servername,
        contentLength: request.headers['content-length'],
        contentType: request.headers['content-type'],
        signature: request.headers['x-void-auth-setup'],
        body,
      });
      if (responseMode === 'redirect') {
        response.writeHead(302, { Location: '/redirect-target' }).end();
      } else if (responseMode === 'oversized') {
        const body = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x78);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.byteLength),
        }).end(body);
      } else {
        const body = Buffer.from('{"accepted":true}', 'utf8');
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(body.byteLength),
        }).end(body);
      }
    },
  };
}

async function nativeSetupFetch({ ca = certificates.ca, port = 4485 } = {}) {
  const origin = `https://control.example.test:${port}`;
  const inspected = makeInspectingEngine({ hostPort: port });
  const fetcher = await createAuthSetupFetch({
    engine: inspected.engine,
    controlOrigin: origin,
    ca,
  });
  return { fetcher, inspected, origin };
}

test('native inspected ingress preserves DNS Host/SNI, trusted CA, and exact signed UTF-8 request bytes', async () => {
  const recorder = newRequestRecorder();
  const server = await startHttpsServer({
    key: await certificates.valid.key,
    certificate: await certificates.valid.certificate,
    port: NATIVE_INGRESS_PORT,
    onRequest: recorder.handle,
  });
  try {
    const { fetcher, inspected, origin } = await nativeSetupFetch();
    const body = '{"display":"Café ☕"}';
    const response = await fetcher(`${origin}${SETUP_PATH}`, validRequest(body));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"accepted":true}');
    assert.deepEqual(inspected.inspected, [`${SCOPE}-tls-ingress`]);
    assert.equal(recorder.records.length, 1);
    const [request] = recorder.records;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, SETUP_PATH);
    assert.equal(request.host, new URL(origin).host);
    assert.equal(request.servername, 'control.example.test');
    assert.equal(request.contentType, 'application/json');
    assert.equal(request.contentLength, String(Buffer.byteLength(body, 'utf8')));
    assert.equal(request.signature, createHmac('sha256', SYNTHETIC_SETUP_TOKEN)
      .update(body, 'utf8')
      .digest('base64url'));
    assert.deepEqual(request.body, Buffer.from(body, 'utf8'));
  } finally {
    await closeHttpsServer(server);
  }
});

test('external-TLS ingress inspection connects to canonical localhost with the configured certificate', async () => {
  const recorder = newRequestRecorder();
  const server = await startHttpsServer({
    key: await certificates.valid.key,
    certificate: await certificates.valid.certificate,
    host: 'localhost',
    onRequest: recorder.handle,
  });
  try {
    const port = server.address().port;
    const origin = `https://localhost:${port}`;
    const inspected = makeInspectingEngine({ hostPort: port });
    const fetcher = await createAuthSetupFetch({
      engine: inspected.engine,
      controlOrigin: origin,
      ca: certificates.ca,
      externalTls: { controlPort: port, appPort: 4486 },
    });
    const response = await fetcher(`${origin}${SETUP_PATH}`, validRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(inspected.inspected, [`${SCOPE}-control-ingress`]);
    assert.equal(recorder.records[0]?.host, new URL(origin).host);
    assert.equal(recorder.records[0]?.servername, 'localhost');
  } finally {
    await closeHttpsServer(server);
  }
});

test('request target, method, headers, abort, and UTF-8 byte limit reject before ingress effects', async () => {
  const recorder = newRequestRecorder();
  const server = await startHttpsServer({
    key: await certificates.valid.key,
    certificate: await certificates.valid.certificate,
    port: NATIVE_INGRESS_PORT,
    onRequest: recorder.handle,
  });
  try {
    const { fetcher, origin } = await nativeSetupFetch();
    const url = `${origin}${SETUP_PATH}`;
    const rejectsWith = async (input, init, code) => {
      await assert.rejects(fetcher(input, init), (error) => error?.code === code);
    };

    await rejectsWith(`${origin}/wrong-path`, validRequest(), 'auth_setup_target_refused');
    await rejectsWith(`${url}?x=1`, validRequest(), 'auth_setup_target_refused');
    await rejectsWith(`https://other.example.test:4485${SETUP_PATH}`, validRequest(), 'auth_setup_target_refused');
    await rejectsWith(url, validRequest('{}', { method: 'GET' }), 'auth_setup_target_refused');
    await rejectsWith(url, validRequest('{}', { redirect: 'follow' }), 'auth_setup_target_refused');
    await rejectsWith(url, validRequest('{}', { headers: {
      'content-type': 'application/json',
      'x-void-auth-setup': createHmac('sha256', SYNTHETIC_SETUP_TOKEN).update('{}').digest('base64url'),
      origin: origin,
    } }), 'auth_setup_headers_invalid');
    await rejectsWith(url, validRequest('{}', { headers: { 'content-type': 'application/json' } }), 'auth_setup_headers_invalid');
    await rejectsWith(url, validRequest('{}', { headers: {
      'content-type': 'text/plain',
      'x-void-auth-setup': createHmac('sha256', SYNTHETIC_SETUP_TOKEN).update('{}').digest('base64url'),
    } }), 'auth_setup_headers_invalid');
    await rejectsWith(url, validRequest('', {}), 'auth_setup_request_size');
    await rejectsWith(url, validRequest('x'.repeat(MAX_REQUEST_BYTES + 1)), 'auth_setup_request_size');
    await rejectsWith(url, validRequest('{}', { signal: AbortSignal.abort() }), 'auth_setup_request_aborted');
    assert.equal(recorder.records.length, 0, 'invalid requests must not reach the ingress server');

    const boundaryBody = 'x'.repeat(MAX_REQUEST_BYTES);
    const response = await fetcher(url, validRequest(boundaryBody));
    assert.equal(response.status, 200);
    assert.equal(recorder.records.length, 1);
    assert.equal(recorder.records[0]?.body.byteLength, MAX_REQUEST_BYTES);
    assert.equal(recorder.records[0]?.contentLength, String(MAX_REQUEST_BYTES));
  } finally {
    await closeHttpsServer(server);
  }
});

test('untrusted CA and wrong certificate hostname fail before HTTP request effects', async () => {
  const recorder = newRequestRecorder();
  const validServer = await startHttpsServer({
    key: await certificates.valid.key,
    certificate: await certificates.valid.certificate,
    port: NATIVE_INGRESS_PORT,
    onRequest: recorder.handle,
  });
  try {
    const { fetcher, origin } = await nativeSetupFetch({ ca: certificates.wrongCa });
    await assert.rejects(fetcher(`${origin}${SETUP_PATH}`, validRequest()), (error) => {
      assert.ok([
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'SELF_SIGNED_CERT_IN_CHAIN',
      ].includes(error?.code), `expected a certificate trust error, received ${error?.code}`);
      return true;
    });
    assert.equal(recorder.records.length, 0);
  } finally {
    await closeHttpsServer(validServer);
  }

  const wrongHostnameServer = await startHttpsServer({
    key: await certificates.wrongHostname.key,
    certificate: await certificates.wrongHostname.certificate,
    port: NATIVE_INGRESS_PORT,
    onRequest: recorder.handle,
  });
  try {
    const { fetcher, origin } = await nativeSetupFetch();
    await assert.rejects(fetcher(`${origin}${SETUP_PATH}`, validRequest()), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    assert.equal(recorder.records.length, 0);
  } finally {
    await closeHttpsServer(wrongHostnameServer);
  }
});

test('manual redirects are not followed and oversized responses fail with the transport size cause', async () => {
  const recorder = newRequestRecorder();
  const server = await startHttpsServer({
    key: await certificates.valid.key,
    certificate: await certificates.valid.certificate,
    port: NATIVE_INGRESS_PORT,
    onRequest: recorder.handle,
  });
  try {
    const { fetcher, origin } = await nativeSetupFetch();
    recorder.setResponseMode('redirect');
    const redirect = await fetcher(`${origin}${SETUP_PATH}`, validRequest());
    assert.equal(redirect.status, 302);
    assert.equal(recorder.records.length, 1);
    assert.equal(recorder.redirectTargetRequests, 0);

    recorder.setResponseMode('oversized');
    await assert.rejects(
      fetcher(`${origin}${SETUP_PATH}`, validRequest()),
      { code: 'auth_setup_response_size' },
    );
    assert.equal(recorder.records.length, 2);
    assert.equal(recorder.redirectTargetRequests, 0);
  } finally {
    await closeHttpsServer(server);
  }
});
