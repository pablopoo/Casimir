import http from 'node:http';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ExecutorGuard } from './guard.ts';
import { recipe } from './profile.ts';
export class DockerTransport {
  constructor(
    readonly socketPath: string,
    private guard?: ExecutorGuard,
    private timeout = 5000,
  ) {}
  async requestBytes(
    method: string,
    path: string,
    body: Readable,
    headers: Record<string, string>,
  ): Promise<Array<unknown>> {
    this.guard?.assertLive();
    if (!this.guard || method !== 'POST' || !path.startsWith('/build?')) {
      throw new Error('guarded_build_required');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error: Error | null, value: Array<unknown> = []) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const req = http.request(
        { socketPath: this.socketPath, path: `/${recipe.apiVersion}${path}`, method, headers },
        (res) => {
          let size = 0;
          const chunks: Array<Buffer> = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              done(new Error('docker_response_limit'));
              req.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          res.on('error', () => done(new Error('docker_unavailable')));
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 400) {
              return done(new Error('docker_build_failed'));
            }
            try {
              const events = Buffer.concat(chunks)
                .toString('utf8')
                .split('\n')
                .filter((line: string) => line.trim())
                .map((line: string): unknown => JSON.parse(line));
              if (
                events.some(
                  (event: unknown) =>
                    !event ||
                    typeof event !== 'object' ||
                    ('error' in event && event.error) ||
                    ('errorDetail' in event && event.errorDetail),
                )
              ) {
                return done(new Error('docker_build_failed'));
              }
              done(null, events);
            } catch {
              done(new Error('docker_invalid_response'));
            }
          });
        },
      );
      const abort = () => {
        done(new Error('executor_session_lost'));
        req.destroy();
        body.destroy();
      };
      this.guard!.signal.addEventListener('abort', abort, { once: true });
      if (this.guard!.signal.aborted) {
        abort();
      }
      const timer = setTimeout(() => {
        done(new Error('docker_timeout'));
        req.destroy();
        body.destroy();
      }, this.timeout);
      req.on('close', () => {
        clearTimeout(timer);
        this.guard!.signal.removeEventListener('abort', abort);
      });
      req.on('error', () => done(new Error('docker_unavailable')));
      let sent = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sent += chunk.length;
          callback(sent > 300 * 1024 * 1024 ? new Error('docker_context_limit') : null, chunk);
        },
      });
      void pipeline(body, limit, req).catch((error) => {
        done(
          new Error(
            error.message === 'docker_context_limit'
              ? 'docker_context_limit'
              : 'docker_unavailable',
          ),
        );
        req.destroy();
      });
    });
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    timeout = this.timeout,
  ): Promise<any> {
    if (method !== 'GET') this.guard?.assertLive();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve(value);
      };
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: `/${recipe.apiVersion}${path}`,
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              done(new Error('docker_response_limit'));
              req.destroy();
            } else chunks.push(chunk);
          });
          res.on('error', () => done(new Error('docker_unavailable')));
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 400)
              return done(
                new Error(
                  res.statusCode === 404
                    ? 'docker_not_found'
                    : res.statusCode === 409
                      ? 'docker_conflict'
                      : 'docker_unavailable',
                ),
              );
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return done(null, null);
            try {
              done(null, JSON.parse(text));
            } catch {
              done(new Error('docker_invalid_response'));
            }
          });
        },
      );
      const abort = () => req.destroy(new Error('executor_session_lost'));
      this.guard?.signal.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => {
        done(new Error('docker_timeout'));
        req.destroy();
      }, timeout);
      req.on('close', () => {
        clearTimeout(deadline);
        this.guard?.signal.removeEventListener('abort', abort);
      });
      req.on('error', () => done(new Error('docker_unavailable')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateTarget } from './routing.ts';
import type { ExecutionProfile, Operation, Target, Observation, RouteIdentity } from './types.ts';
const taskLabels = {
  'org.casimir.task': 'execution-poc',
  'org.casimir.scope': 'casimir-execution-poc',
};
const probeScript = `const expected=JSON.parse(process.env.CASIMIR_EXPECTED); const base='http://127.0.0.1:4284';
const r=await fetch(base+'/version',{signal:AbortSignal.timeout(2000)});
if(!expected){if(r.status!==503)process.exit(1);}else{
 const b=await r.json();const h=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)});
 if(!r.ok||!h.ok||b.deploymentId!==expected.deploymentId||b.projectId!==expected.projectId||b.version!==expected.version||r.headers.get('x-casimir-deployment')!==expected.deploymentId||r.headers.get('x-casimir-image')!==expected.imageId||r.headers.get('x-casimir-project')!==expected.projectId)process.exit(1);
}`;
export class FixedEngine {
  private transport: DockerTransport;
  private guard?: ExecutorGuard;
  constructor(
    private options: { socketPath: string; profile: ExecutionProfile; preparation?: boolean },
  ) {
    this.transport = new DockerTransport(options.socketPath);
  }
  setGuard(guard: ExecutorGuard) {
    this.guard = guard;
    this.transport = new DockerTransport(this.options.socketPath, guard);
  }
  private live() {
    if (!this.guard && !this.options.preparation) throw new Error('executor guard required');
    this.guard?.assertLive();
  }
  async verifyEnvironment() {
    const version = await this.transport.request('GET', '/version');
    verifyDockerApiVersion(version);
    for (const id of Object.values(this.options.profile.images)) await this.inspectImage(id);
    for (const name of ['casimir-execution-poc_app', 'casimir-execution-poc_runtime']) {
      const network = await this.transport.request('GET', `/networks/${name}`);
      if (!network.Internal || network.Labels?.['org.casimir.task'] !== 'execution-poc')
        throw new Error('resource ownership mismatch');
    }
    for (const name of ['casimir-execution-poc_appdata', 'casimir-execution-poc_routes']) {
      const volume = await this.transport.request('GET', `/volumes/${name}`);
      if (volume.Labels?.['org.casimir.task'] !== 'execution-poc')
        throw new Error('resource ownership mismatch');
    }
  }
  async inspectImage(id: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('image invalid');
    const image = await this.transport.request('GET', `/images/${id}/json`);
    if (image.Id !== id) throw new Error('image identity mismatch');
    return image;
  }
  async inspectContainer(id: string): Promise<any | null> {
    if (!/^[a-f0-9]{12,64}$/.test(id) && !/^casimir-execution-poc-[a-z0-9_-]+$/.test(id))
      throw new Error('container invalid');
    try {
      return await this.transport.request('GET', `/containers/${id}/json`);
    } catch (e) {
      if ((e as Error).message === 'docker_not_found') return null;
      throw e;
    }
  }
  async listOwnedContainers() {
    return this.transport.request(
      'GET',
      '/containers/json?all=1&filters=' +
        encodeURIComponent(
          JSON.stringify({
            label: [
              'org.casimir.task=execution-poc',
              'org.casimir.scope=casimir-execution-poc',
              'org.casimir.role=app',
            ],
          }),
        ),
    );
  }
  candidateName(op: Operation) {
    if (!/^cex_[a-z0-9]{12}$/.test(op.id)) throw new Error('invalid operation');
    return 'casimir-execution-poc-app-' + op.id;
  }
  private appLabels(op: Operation) {
    return {
      ...taskLabels,
      'org.casimir.role': 'app',
      'org.casimir.operation': op.id,
      'org.casimir.project': op.project_id,
      'org.casimir.deployment': op.deployment_id,
      'org.casimir.profile': op.profile_hash,
    };
  }
  async ensureCandidate(op: Operation, mode: 'read-only' | 'writable') {
    this.live();
    if (
      op.profile_hash !== this.options.profile.fingerprint ||
      this.options.profile.images[op.image_alias] !== op.image_id
    )
      throw new Error('profile drift');
    const name = this.candidateName(op);
    await this.inspectImage(op.image_id);
    let container = await this.inspectContainer(name);
    if (container) {
      this.validateCandidate(op, container, mode);
      return container.Id as string;
    }
    const body = {
      Image: op.image_id,
      User: '1000:1000',
      WorkingDir: '/app',
      Cmd: ['node', '/app/server.mjs'],
      Env: [
        `CASIMIR_PROJECT_ID=${op.project_id}`,
        `CASIMIR_DEPLOYMENT_ID=${op.deployment_id}`,
        `CASIMIR_MODE=${mode}`,
      ],
      Labels: this.appLabels(op),
      HostConfig: {
        NetworkMode: recipe.network,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: recipe.appMemory,
        NanoCpus: recipe.appNanoCpus,
        PidsLimit: recipe.appPids,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
        Mounts: [
          {
            Type: 'volume',
            Source: recipe.volume,
            Target: '/data',
            ReadOnly: mode === 'read-only',
          },
        ],
        RestartPolicy: { Name: 'no' },
      },
      NetworkingConfig: { EndpointsConfig: { [recipe.network]: {} } },
    };
    const result = await this.transport.request('POST', `/containers/create?name=${name}`, body);
    container = await this.inspectContainer(result.Id);
    this.validateCandidate(op, container, mode);
    return result.Id as string;
  }
  validateCandidate(op: Operation, c: any, mode?: 'read-only' | 'writable') {
    if (!c || c.Image !== op.image_id) throw new Error('candidate identity mismatch');
    for (const [key, value] of Object.entries(this.appLabels(op)))
      if (c.Config?.Labels?.[key] !== value) throw new Error('candidate identity mismatch');
    const volume = c.Mounts?.find((m: any) => m.Destination === '/data');
    const actualMode = c.Config?.Env?.find((s: string) => s.startsWith('CASIMIR_MODE='))?.slice(13);
    if (
      c.Config.User !== '1000:1000' ||
      !c.HostConfig.ReadonlyRootfs ||
      volume?.Name !== recipe.volume ||
      c.Mounts.length !== 1 ||
      !['read-only', 'writable'].includes(actualMode) ||
      volume.RW !== (actualMode === 'writable') ||
      (mode && actualMode !== mode) ||
      Object.keys(c.HostConfig.PortBindings ?? {}).length ||
      c.HostConfig.Memory !== recipe.appMemory ||
      c.HostConfig.NanoCpus !== recipe.appNanoCpus ||
      Number(c.HostConfig.PidsLimit) !== recipe.appPids ||
      !c.HostConfig.CapDrop?.includes('ALL') ||
      !c.HostConfig.SecurityOpt?.includes('no-new-privileges:true') ||
      Object.keys(c.NetworkSettings.Networks ?? {}).join(',') !== recipe.network
    )
      throw new Error('candidate recipe mismatch');
    return actualMode;
  }
  private owned(c: any) {
    if (
      c?.Config?.Labels?.['org.casimir.task'] !== 'execution-poc' ||
      c.Config.Labels['org.casimir.scope'] !== 'casimir-execution-poc'
    )
      throw new Error('foreign container');
  }
  async start(id: string) {
    this.live();
    const c = await this.inspectContainer(id);
    this.owned(c);
    if (!c.State.Running) await this.transport.request('POST', `/containers/${c.Id}/start`);
  }
  async stop(id: string) {
    this.live();
    const c = await this.inspectContainer(id);
    if (!c) return;
    this.owned(c);
    if (c.State.Running)
      await this.transport.request('POST', `/containers/${c.Id}/stop?t=10`, undefined, 15000);
    const stopped = await this.inspectContainer(c.Id);
    if (stopped?.State.Running) throw new Error('writer still running');
  }
  async removeOwned(id: string) {
    this.live();
    const c = await this.inspectContainer(id);
    if (!c) return;
    this.owned(c);
    if (c.State.Running) throw new Error('container still running');
    await this.transport.request('DELETE', `/containers/${c.Id}`);
  }
  async observeCandidate(op: Operation): Promise<{ target: Target; writable: boolean }> {
    const deadline = Date.now() + 30000;
    let reason = 'candidate unhealthy';
    while (Date.now() < deadline) {
      this.guard?.assertLive();
      const c = await this.inspectContainer(this.candidateName(op));
      const mode = this.validateCandidate(op, c);
      if (c.State.Running) {
        try {
          const ip = c.NetworkSettings.Networks[recipe.network].IPAddress;
          const health = await fetch(`http://${ip}:3000/health`, {
            signal: AbortSignal.timeout(2000),
          });
          const version = await fetch(`http://${ip}:3000/version`, {
            signal: AbortSignal.timeout(2000),
          });
          const b = (await version.json()) as {
            deploymentId?: unknown;
            projectId?: unknown;
            version?: unknown;
            writable?: unknown;
          };
          const expected = op.image_alias.slice(5);
          if (
            health.ok &&
            version.ok &&
            b.deploymentId === op.deployment_id &&
            b.projectId === op.project_id &&
            b.version === expected &&
            b.writable === (mode === 'writable')
          )
            return {
              target: {
                projectId: op.project_id,
                deploymentId: op.deployment_id,
                containerId: c.Id,
                imageId: c.Image,
                version: b.version,
              },
              writable: mode === 'writable',
            };
        } catch {
          reason = 'candidate probe failed';
        }
      }
      await delay(500, undefined, { signal: this.guard?.signal });
    }
    throw new Error(reason);
  }
  async validateRecordedTarget(target: Target) {
    validateTarget(target);
    const c = await this.inspectContainer(target.containerId);
    this.owned(c);
    if (
      c.Image !== target.imageId ||
      c.Config.Labels['org.casimir.project'] !== target.projectId ||
      c.Config.Labels['org.casimir.deployment'] !== target.deploymentId ||
      c.Config.Labels['org.casimir.role'] !== 'app'
    )
      throw new Error('previous identity mismatch');
    const mount = c.Mounts?.find((m: any) => m.Destination === '/data');
    if (mount?.Name !== recipe.volume || !mount.RW) throw new Error('previous recipe mismatch');
    await this.inspectImage(target.imageId);
    return c;
  }
  async reloadProxy() {
    this.live();
    const proxy = await this.inspectContainer('casimir-execution-poc-app-ingress-1');
    this.owned(proxy);
    if (proxy.Config.Labels['org.casimir.role'] !== 'app-ingress')
      throw new Error('proxy identity mismatch');
    const e = await this.transport.request('POST', `/containers/${proxy.Id}/exec`, {
      Cmd: ['nginx', '-c', '/routes/route.conf', '-s', 'reload'],
      AttachStdout: false,
      AttachStderr: false,
    });
    await this.transport.request('POST', `/exec/${e.Id}/start`, { Detach: true });
    for (let n = 0; n < 20; n++) {
      const state = await this.transport.request('GET', `/exec/${e.Id}/json`);
      if (!state.Running) {
        if (state.ExitCode !== 0) throw new Error('proxy reload failed');
        return;
      }
      await delay(100);
    }
    throw new Error('proxy reload timeout');
  }
  private jobLabels(role: string, op?: Operation) {
    if (
      op &&
      (!/^cex_[a-z0-9]{12}$/.test(op.id) ||
        op.profile_hash !== this.options.profile.fingerprint ||
        op.executor_instance !== this.guard?.instance)
    )
      throw new Error('job ownership mismatch');
    if (!op && !this.options.preparation) throw new Error('job operation required');
    return {
      ...taskLabels,
      'org.casimir.role': role,
      'org.casimir.operation': op?.id ?? 'operator',
      'org.casimir.project': op?.project_id ?? 'operator',
      'org.casimir.profile': this.options.profile.fingerprint,
      'org.casimir.executor': op?.executor_instance ?? 'operator',
    };
  }
  async reconcileJobs(lookup: (id: string) => Promise<Operation>) {
    this.live();
    const jobs = await this.transport.request(
      'GET',
      '/containers/json?all=1&filters=' +
        encodeURIComponent(
          JSON.stringify({
            label: ['org.casimir.task=execution-poc', 'org.casimir.scope=casimir-execution-poc'],
          }),
        ),
    );
    const owned = [];
    for (const row of jobs) {
      const c = await this.inspectContainer(row.Id);
      const labels = c?.Config?.Labels;
      const role = labels?.['org.casimir.role'];
      if (!['data-init', 'probe'].includes(role)) continue;
      const id = labels['org.casimir.operation'];
      const op = id === 'operator' && role === 'probe' ? undefined : await lookup(id);
      const executor = labels['org.casimir.executor'];
      if (
        labels['org.casimir.profile'] !== this.options.profile.fingerprint ||
        (op
          ? op.profile_hash !== this.options.profile.fingerprint ||
            op.project_id !== labels['org.casimir.project'] ||
            op.executor_instance !== executor
          : executor !== 'operator' || labels['org.casimir.project'] !== 'operator') ||
        !new RegExp(
          '^/casimir-execution-poc-' + (role === 'probe' ? 'probe' : 'init') + '-[a-f0-9]{12}$',
        ).test(c.Name)
      )
        throw new Error('job ownership mismatch');
      const body =
        role === 'data-init'
          ? this.initBody(op!.project_id)
          : this.probeBody(
              JSON.parse(
                c.Config.Env.find((s: string) => s.startsWith('CASIMIR_EXPECTED='))?.slice(17) ??
                  'invalid',
              ),
            );
      const h = c.HostConfig,
        expected = body.HostConfig;
      if (
        c.Image !== body.Image ||
        c.Config.User !== body.User ||
        JSON.stringify(c.Config.Cmd) !== JSON.stringify(body.Cmd) ||
        !body.Env.every((e: string) => c.Config.Env.includes(e)) ||
        (['NetworkMode', 'ReadonlyRootfs', 'Memory', 'NanoCpus'] as const).some(
          (k) => h[k] !== expected[k],
        ) ||
        Number(h.PidsLimit) !== expected.PidsLimit ||
        JSON.stringify(h.CapDrop) !== JSON.stringify(expected.CapDrop) ||
        JSON.stringify(h.CapAdd ?? []) !==
          JSON.stringify('CapAdd' in expected ? expected.CapAdd : []) ||
        !h.SecurityOpt?.includes('no-new-privileges:true') ||
        Object.keys(h.PortBindings ?? {}).length ||
        c.Mounts.length !== (role === 'data-init' ? 1 : 0) ||
        (role === 'data-init' &&
          (c.Mounts[0].Name !== recipe.volume ||
            c.Mounts[0].Destination !== '/data' ||
            !c.Mounts[0].RW))
      )
        throw new Error('job ownership mismatch');
      owned.push(c.Id);
    }
    // Validate every job before making any recovery mutation.
    for (const id of owned) {
      await this.stop(id);
      await this.removeOwned(id);
    }
  }
  private async job(name: string, body: any) {
    this.live();
    let id: string | undefined;
    try {
      const result = await this.transport.request('POST', `/containers/create?name=${name}`, body);
      id = result.Id;
      await this.start(id!);
      if (process.env.CASIMIR_TEST_FAILPOINT === 'after_job_start') {
        console.log('Casimir test checkpoint after_job_start', id);
        await delay(60000, undefined, { signal: this.guard?.signal });
      }
      const wait = await this.transport.request(
        'POST',
        `/containers/${id}/wait?condition=not-running`,
        undefined,
        10000,
      );
      if (wait.StatusCode !== 0) throw new Error('trusted job failed');
    } finally {
      if (id) {
        await this.stop(id);
        await this.removeOwned(id);
      }
    }
  }
  async initializeAppData(projectId: string, op: Operation) {
    this.live();
    if (!/^proj_[a-z0-9]{12}$/.test(projectId)) throw new Error('project invalid');
    const apps = await this.listOwnedContainers();
    if (apps.some((c: any) => c.State === 'running'))
      throw new Error('initialization while app running');
    await this.job('casimir-execution-poc-init-' + randomBytes(6).toString('hex'), {
      ...this.initBody(projectId),
      Labels: this.jobLabels('data-init', op),
    });
  }
  private initBody(projectId: string) {
    return {
      Image: this.options.profile.images['demo-v1'],
      User: '0:0',
      Cmd: ['node', '/app/init-data.mjs'],
      Env: [`CASIMIR_PROJECT_ID=${projectId}`],
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'DAC_OVERRIDE'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 134217728,
        NanoCpus: 250000000,
        PidsLimit: 64,
        Mounts: [{ Type: 'volume', Source: recipe.volume, Target: '/data', ReadOnly: false }],
        RestartPolicy: { Name: 'no' },
      },
    };
  }
  private probeBody(target: Target | null) {
    if (target) validateTarget(target);
    return {
      Image: this.options.profile.images['demo-v1'],
      User: '1000:1000',
      Cmd: ['node', '--input-type=module', '-e', probeScript],
      Env: [`CASIMIR_EXPECTED=${JSON.stringify(target)}`],
      HostConfig: {
        NetworkMode: 'host',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 134217728,
        NanoCpus: 250000000,
        PidsLimit: 64,
        RestartPolicy: { Name: 'no' },
      },
    };
  }
  async runLoopbackProbe(
    target: Target | null,
    route: RouteIdentity,
    op?: Operation,
  ): Promise<Observation> {
    await this.job('casimir-execution-poc-probe-' + randomBytes(6).toString('hex'), {
      ...this.probeBody(target),
      Labels: this.jobLabels('probe', op),
    });
    return {
      target,
      route,
      healthy: target !== null,
      writable: target !== null,
      loopbackVerified: true,
      observedAt: new Date().toISOString(),
    };
  }
}
export const createEngine = (options: ConstructorParameters<typeof FixedEngine>[0]) =>
  new FixedEngine(options);

export function verifyDockerApiVersion(value: unknown): void {
  const fail = () => {
    throw new Error('docker_api_incompatible');
  };
  if (!value || typeof value !== 'object') {
    return fail();
  }
  const parse = (input: unknown): [number, number] => {
    if (typeof input !== 'string' || !/^[1-9]\d{0,3}\.\d{1,4}$/.test(input)) {
      return fail();
    }
    const parts = input.split('.').map(Number);
    return [parts[0]!, parts[1]!];
  };
  const version = value as { MinAPIVersion: unknown; ApiVersion: unknown },
    min = parse(version.MinAPIVersion),
    max = parse(version.ApiVersion);
  if (min[0] > 1 || (min[0] === 1 && min[1] > 47) || max[0] < 1 || (max[0] === 1 && max[1] < 47)) {
    fail();
  }
}
