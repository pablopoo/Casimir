import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  CASIMIR_LIMITS,
  parseRuntimeDescriptor,
  assertCasimirRuntime,
  type RuntimeDescriptor,
} from '@void/deploy-core';
import { join } from 'pathslash';
import { getPackageDir } from './agents.ts';
export type CasimirCredential = Readonly<{ token: string; origin: string }>;
export type CasimirReceipt = Readonly<{ operationId: string; deploymentId: string }>;
export function casimirOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid_casimir_origin');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('invalid_casimir_origin');
  }
  return url.origin;
}
function object(value: unknown, keys?: Array<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('protocol_response');
  }
  if (
    keys &&
    (Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k)))
  ) {
    throw new Error('protocol_response');
  }
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('protocol_response');
  }
  return value;
}
export class CasimirClient {
  readonly origin: string;
  constructor(
    url: string,
    private credential: CasimirCredential,
    private options: { timeout?: number; expected?: RuntimeDescriptor } = {},
  ) {
    this.origin = casimirOrigin(url);
    if (casimirOrigin(credential.origin) !== this.origin) {
      throw new Error('credential_origin');
    }
    if (!/^[\x21-\x7e]{1,4096}$/.test(credential.token)) {
      throw new Error('invalid_credential');
    }
  }
  private async request(
    path: string,
    init: RequestInit & { duplex?: 'half' } = {},
    authenticated = true,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        ...init,
        headers: {
          ...init.headers,
          ...(authenticated ? { Authorization: `Bearer ${this.credential.token}` } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeout ?? 30000),
      });
    } catch {
      throw new Error('casimir_request_failed');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('casimir_redirect_refused');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`casimir_http_${response.status}`);
    }
    if (!response.body) {
      throw new Error('protocol_response');
    }
    const reader = response.body.getReader();
    let count = 0;
    const chunks: Array<Uint8Array> = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        count += chunk.value.byteLength;
        if (count > 16384) {
          throw new Error('protocol_response_limit');
        }
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      await reader.cancel().catch(() => {});
      throw new Error('protocol_response');
    } finally {
      reader.releaseLock();
    }
  }
  private json(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
  async connect(): Promise<RuntimeDescriptor> {
    const runtime = parseRuntimeDescriptor(await this.request('/casimir/v1/info', {}, false));
    const pkg = JSON.parse(await readFile(join(getPackageDir(), 'package.json'), 'utf8')) as {
      version: string;
    };
    if (
      runtime.sdkVersion !== pkg.version ||
      runtime.nodeAbi !== process.versions.modules ||
      process.platform !== 'linux' ||
      process.arch !== 'x64'
    ) {
      throw new Error('runtime_mismatch');
    }
    if (this.options.expected) {
      assertCasimirRuntime(runtime, this.options.expected);
    }
    id(object(await this.request('/casimir/v1/identity'), ['actorId']).actorId);
    return runtime;
  }
  async findProjectBySlug(slug: string): Promise<Record<string, unknown> | null> {
    try {
      return object(await this.request('/projects/by-slug/' + encodeURIComponent(slug)));
    } catch (error) {
      if (error instanceof Error && error.message === 'casimir_http_404') {
        return null;
      }
      throw error;
    }
  }
  async project(projectId: string): Promise<Record<string, unknown>> {
    return object(await this.request(`/projects/${encodeURIComponent(id(projectId))}`));
  }
  async createProject(slug: string): Promise<Record<string, unknown>> {
    return object(await this.json('/projects', { slug }));
  }
  async upload(projectId: string, path: string): Promise<{ artifactId: string }> {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > CASIMIR_LIMITS.compressed
    ) {
      throw new Error('artifact_size');
    }
    const h = createHash('sha256'),
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      let count = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        count += chunk.length;
        if (count > CASIMIR_LIMITS.compressed) {
          throw new Error('artifact_size');
        }
        h.update(chunk);
      }
    } finally {
      await handle.close();
    }
    const prefix = `/casimir/v1/projects/${encodeURIComponent(id(projectId))}/uploads`;
    const uploadId = id(
      object(await this.json(prefix, { bytes: stat.size, sha256: h.digest('hex') }), ['uploadId'])
        .uploadId,
    );
    const content = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = content.createReadStream();
    try {
      await this.request(`${prefix}/${encodeURIComponent(uploadId)}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Readable.toWeb(stream) as unknown as BodyInit,
        duplex: 'half',
      });
    } finally {
      stream.destroy();
      await content.close().catch(() => {});
    }
    return {
      artifactId: id(
        object(await this.json(`${prefix}/${encodeURIComponent(uploadId)}/finalize`, {}), [
          'artifactId',
        ]).artifactId,
      ),
    };
  }
  async deploy(projectId: string, artifactId: string, key: string): Promise<CasimirReceipt> {
    if (!/^[\x20-\x7e]{1,128}$/.test(key)) {
      throw new Error('invalid_idempotency_key');
    }
    const result = object(
      await this.json(
        `/casimir/v1/projects/${encodeURIComponent(id(projectId))}/deployments`,
        { artifactId: id(artifactId) },
        { 'Idempotency-Key': key },
      ),
      ['operationId', 'deploymentId'],
    );
    return { operationId: id(result.operationId), deploymentId: id(result.deploymentId) };
  }
  async operation(projectId: string, operationId: string): Promise<Record<string, unknown>> {
    const result = object(
      await this.request(
        `/casimir/v1/projects/${encodeURIComponent(id(projectId))}/operations/${encodeURIComponent(id(operationId))}`,
      ),
    );
    if (result.operationId !== operationId || typeof result.phase !== 'string') {
      throw new Error('protocol_response');
    }
    return result;
  }
  async deployments(projectId: string): Promise<Record<string, unknown>> {
    return object(
      await this.request(`/casimir/v1/projects/${encodeURIComponent(id(projectId))}/deployments`),
    );
  }
}
