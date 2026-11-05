import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { createIdentityTransport } from '../../../src/casimir/management/identity-transport.ts';
import { parseIdentityPolicy } from '../../../src/casimir/management/identity-policy.ts';

const inputChunks = [];
for await (const chunk of process.stdin) inputChunks.push(chunk);
const input = Buffer.concat(inputChunks).toString('utf8');
const separator = input.indexOf('\n');
if (separator < 0) throw new Error('fixture_input_invalid');
const address = input.slice(0, separator).trim();
const caPem = input.slice(separator + 1);
const origin = 'https://idp.example.com';
const wrongHostnameOrigin = 'https://wrong-idp.example.com';
const endpoint = (path) => `${origin}${path}`;
const decodedBodyLimitMessage = 'The identity provider response is too large.';
const undiciResponseLimitCode = 'UND_ERR_RES_EXCEEDED_MAX_SIZE';

function errorCodes(error) {
  const codes = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === 'string') codes.push(current.code);
    current = current.cause;
  }
  return codes;
}

const evidence = {
  defaultPrivateDestinationDenied: false,
  certificateFailures: {},
  allowedPrivateOriginRequestCounts: [],
  redirectRejected: false,
  sizeLimitOracleNegativeControl: null,
  oversizedBodiesRejected: {},
};

const defaultTransport = createIdentityTransport();
try {
  let denied;
  try {
    await defaultTransport.fetch(endpoint('/probe'));
  } catch (error) {
    denied = error;
  }
  assert.ok(denied, 'default policy unexpectedly reached the private IdP');
  assert.ok(errorCodes(denied).includes('EAI_AGAIN'), 'default denial was not the address-policy lookup failure');
  evidence.defaultPrivateDestinationDenied = true;
} finally {
  await defaultTransport.close();
}

const certificateErrorCodes = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

async function rejectCertificateFailure(label, transport, url, expectedCode) {
  let failure;
  try {
    await transport.fetch(url);
  } catch (error) {
    failure = error;
  } finally {
    await transport.close();
  }
  assert.ok(failure, `${label} unexpectedly reached the IdP`);
  const codes = errorCodes(failure);
  if (expectedCode) {
    assert.ok(codes.includes(expectedCode), `${label} did not report ${expectedCode}`);
  } else {
    assert.ok(
      codes.some((code) => certificateErrorCodes.has(code)),
      `${label} did not report a certificate validation failure`,
    );
  }
  evidence.certificateFailures[label] = codes.filter((code) => certificateErrorCodes.has(code));
}

await rejectCertificateFailure(
  'missingCa',
  createIdentityTransport(parseIdentityPolicy({ origins: [{ origin, addresses: [address] }] })),
  endpoint('/probe'),
);
await rejectCertificateFailure(
  'wrongCa',
  createIdentityTransport(
    parseIdentityPolicy({ origins: [{ origin, addresses: [address], caPem: rootCertificates[0] }] }),
  ),
  endpoint('/probe'),
);
await rejectCertificateFailure(
  'wrongHostname',
  createIdentityTransport(
    parseIdentityPolicy({
      origins: [
        { origin: wrongHostnameOrigin, addresses: [address], caPem },
      ],
    }),
  ),
  `${wrongHostnameOrigin}/probe`,
  'ERR_TLS_CERT_ALTNAME_INVALID',
);

const policy = parseIdentityPolicy({
  origins: [{ origin, addresses: [address], caPem }],
});
const transport = createIdentityTransport(policy);

async function probe(expectedCount) {
  const response = await transport.fetch(endpoint('/probe'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requestCount, expectedCount);
  evidence.allowedPrivateOriginRequestCounts.push(body.requestCount);
}

function responseSizeFailure(error) {
  const codes = errorCodes(error);
  if (error instanceof Error && error.message === decodedBodyLimitMessage) {
    return { kind: 'decoded_body_limit', codes };
  }
  if (codes.includes(undiciResponseLimitCode)) {
    return { kind: 'undici_response_limit', codes };
  }
  return undefined;
}

const unrelatedLimitControls = [
  Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
  Object.assign(new Error('invalid response framing'), {
    code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  }),
];
for (const unrelated of unrelatedLimitControls) {
  assert.equal(responseSizeFailure(unrelated), undefined, 'unrelated transport errors must not count as body-limit proof');
}
evidence.sizeLimitOracleNegativeControl = {
  rejectedCodes: errorCodes(unrelatedLimitControls[0]).concat(errorCodes(unrelatedLimitControls[1])),
  passed: true,
};

async function rejectOversized(path, expectedKind) {
  let failure;
  try {
    const response = await transport.fetch(endpoint(path));
    await response.body?.cancel();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `oversized response ${path} was returned to the caller`);
  const classification = responseSizeFailure(failure);
  assert.ok(classification, `oversized response ${path} failed without a recognized body-limit signal`);
  if (expectedKind === 'decoded_body_limit') {
    assert.equal(classification.kind, expectedKind, 'compressed response must hit the decoded-body limit');
  }
  evidence.oversizedBodiesRejected[path] = classification;
}

try {
  // A successful request proves this private IdP is reachable with the exact
  // origin/address/CA policy and that the prior denied request had no effect.
  await probe(1);

  let redirectFailure;
  try {
    await transport.fetch(endpoint('/redirect'));
  } catch (error) {
    redirectFailure = error;
  }
  assert.ok(redirectFailure instanceof Error);
  assert.equal(redirectFailure.message, 'Identity endpoint redirects are not allowed.');
  evidence.redirectRejected = true;
  // The IdP counts both requests. A value of three proves the redirect target
  // was not fetched after /probe and /redirect.
  await probe(3);

  await rejectOversized('/raw');
  await probe(5);
  await rejectOversized('/chunked');
  await probe(7);
  // The compressed wire body is small; only the decoded response exceeds 256 KiB.
  await rejectOversized('/gzip', 'decoded_body_limit');
  await probe(9);
} finally {
  await transport.close();
}

process.stdout.write(`${JSON.stringify({ status: 'pass', evidence })}\n`);
