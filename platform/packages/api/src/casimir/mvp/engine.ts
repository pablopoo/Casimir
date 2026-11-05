import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertCasimirRuntime,
  canonicalJson,
  parseRuntimeDescriptor,
  type CasimirManifest,
  type RuntimeDescriptor,
} from '@void/deploy-core';
import { DockerTransport, verifyDockerApiVersion } from '../execution/docker-engine.ts';
import { deriveResources } from '../lifecycle/resources.ts';
import type { ExecutorGuard } from '../execution/guard.ts';
import { artifactImageContext } from './image-context.ts';
import type { MvpOperation } from './types.ts';

type MountRecipe = {
  Type: string;
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
};
type HostRecipe = {
  Init: boolean;
  Memory: number;
  NanoCpus: number;
  PidsLimit: number;
  ReadonlyRootfs: boolean;
  CapDrop: Array<string>;
  SecurityOpt: Array<string>;
  Tmpfs: Record<string, string>;
  NetworkMode: string;
  RestartPolicy: { Name: string };
  Mounts: Array<MountRecipe>;
  PortBindings?: Record<string, unknown>;
  Privileged?: boolean;
  Binds?: Array<string>;
};
type ContainerRecipe = {
  Image: string;
  User: string;
  Env: Array<string>;
  Labels: Record<string, string>;
  Entrypoint?: Array<string>;
  Cmd?: Array<string>;
  HostConfig: HostRecipe;
  NetworkingConfig?: { EndpointsConfig: Record<string, Record<string, never>> };
};
type ImageConfig = {
  Env?: Array<string> | null;
  Labels?: Record<string, string>;
  Entrypoint?: Array<string> | null;
  Cmd?: Array<string> | null;
};
type ImageInspect = { Id: string; Architecture: string; Os: string; Config: ImageConfig };
type ContainerInspect = {
  Id: string;
  Name: string;
  Image: string;
  Config: {
    User: string;
    Env: Array<string>;
    Labels: Record<string, string>;
    Entrypoint: Array<string> | null;
    Cmd: Array<string> | null;
  };
  HostConfig: HostRecipe;
  State: { Running: boolean; Status: string; ExitCode: number; StartedAt: string };
  Mounts?: Array<{ Name?: string; RW: boolean }>;
  NetworkSettings: { Networks: Record<string, { IPAddress?: string }>; Ports?:Record<string,Array<{HostIp:string;HostPort:string}>|null> };
};
export type MvpCleanupJob = {
  id: string;
  action: string;
  parameters: Record<string, unknown>;
  release: MvpOperation;
};

export function selectRuntimeSecrets(
  keys: ReadonlyArray<string>,
  values: unknown,
): Record<string, string> {
  const valid = (key: string) =>
    /^[A-Z][A-Z0-9_]*$/.test(key) &&
    !key.startsWith('CASIMIR_') &&
    !['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key);
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    keys.some((key) => !valid(key)) ||
    Object.entries(values).some(([key, value]) => !valid(key) || typeof value !== 'string')
  ) {
    throw new Error('runtime_env');
  }
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.includes(key))) as Record<
    string,
    string
  >;
}

export class MvpEngine {
  transport: DockerTransport;
  private guard?: ExecutorGuard;
  private imageConfigs = new Map<string, ImageConfig>();
  constructor(
    readonly options: {
      socketPath: string;
      runnerImage: string;
      runtime: RuntimeDescriptor;
      jobTimeoutMs?: number;
      installationId?: string;
      appOrigin?: string;
    },
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.runnerImage)) {
      throw new Error('runner_image');
    }
    if (options.installationId) deriveResources(options.installationId);
    this.transport = new DockerTransport(options.socketPath, undefined, 30000);
  }
  setGuard(guard: ExecutorGuard): void {
    this.guard = guard;
    this.transport = new DockerTransport(this.options.socketPath, guard, 30000);
  }
  get scope(): string {
    return this.options.installationId ? deriveResources(this.options.installationId).scope : 'casimir-mvp-a';
  }
  private resource(role: string): string {
    return this.scope + (this.options.installationId ? '-' : '_') + role;
  }
  private owned(labels: Record<string, string> | undefined): boolean {
    return this.options.installationId
      ? labels?.['org.casimir.installation'] === this.options.installationId
      : labels?.['org.casimir.task'] === 'mvp-a';
  }
  private live(): void {
    if (!this.guard) {
      throw new Error('executor_guard_required');
    }
    this.guard.assertLive();
  }
  async inspectContainer(id: string): Promise<ContainerInspect | null> {
    if (!/^[a-f0-9]{12,64}$/.test(id) && !(id.startsWith(this.scope + '-') && /^[a-z0-9_-]+$/.test(id))) {
      throw new Error('container_identity');
    }
    try {
      return await this.transport.request('GET', `/containers/${id}/json`);
    } catch (error) {
      if ((error as Error).message === 'docker_not_found') {
        return null;
      }
      throw error;
    }
  }
  labels(op: MvpOperation, role = 'prepared-image'): Record<string, string> {
    if (
      !/^cmv_[a-z0-9]{12}$/.test(op.id) ||
      !/^proj_[a-z0-9]{12}$/.test(op.project_id) ||
      !/^car_[a-z0-9]{12}$/.test(op.artifact_id)
    ) {
      throw new Error('operation_identity');
    }
    return {
      'org.casimir.task': this.options.installationId ? 'c1' : 'mvp-a',
      ...(this.options.installationId ? { 'org.casimir.installation': this.options.installationId } : {}),
      'org.casimir.scope': this.scope,
      'org.casimir.role': role,
      'org.casimir.operation': op.id,
      'org.casimir.project': op.project_id,
      'org.casimir.artifact': op.artifact_id,
      'org.casimir.runtime-id': parseRuntimeDescriptor(op.runtime).runtimeId,
    };
  }
  async verifyEnvironment(): Promise<void> {
    verifyDockerApiVersion(await this.transport.request('GET', '/version'));
    const image: ImageInspect = await this.transport.request(
      'GET',
      `/images/${this.options.runnerImage}/json`,
    );
    if (
      image.Id !== this.options.runnerImage ||
      image.Config?.Labels?.['org.casimir.task'] !== 'mvp-a' ||
      image.Config.Labels['org.casimir.runtime-id'] !== this.options.runtime.runtimeId ||
      image.Architecture !== 'amd64' ||
      image.Os !== 'linux'
    ) {
      throw new Error('runner_identity');
    }
    for (const name of [this.resource('runtime'), this.resource('apps')]) {
      const network = await this.transport.request('GET', '/networks/' + name);
      if (!network.Internal || !this.owned(network.Labels)) {
        throw new Error('resource_ownership');
      }
    }
    for (const name of ['appdata', 'artifacts', 'snapshots', 'routes', 'runtime-secrets', 'jobs']) {
      const volume = await this.transport.request('GET', '/volumes/' + this.resource(name));
      if (!this.owned(volume.Labels)) {
        throw new Error('resource_ownership');
      }
    }
  }
  async inspectPreparedImage(id: string, op: MvpOperation): Promise<void> {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
      throw new Error('image_identity');
    }
    const image: ImageInspect = await this.transport.request('GET', `/images/${id}/json`);
    if (image.Id !== id) {
      throw new Error('image_identity');
    }
    for (const [key, value] of Object.entries(this.labels(op))) {
      if (image.Config?.Labels?.[key] !== value) {
        throw new Error('image_ownership');
      }
    }
    this.imageConfigs.set(id, image.Config);
  }
  async buildArtifact(
    directory: string,
    manifest: CasimirManifest,
    op: MvpOperation,
  ): Promise<string> {
    this.live();
    assertCasimirRuntime(manifest, this.options.runtime);
    await this.verifyEnvironment();
    const labels = this.labels(op);
    // A preparation recorded before a crash may have completed in the daemon.
    const filters = encodeURIComponent(
      JSON.stringify({ label: Object.entries(labels).map(([key, value]) => key + '=' + value) }),
    );
    const prior = await this.transport.request('GET', `/images/json?filters=${filters}`);
    if (!Array.isArray(prior) || prior.length > 1) {
      throw new Error('preparation_ambiguous');
    }
    if (prior.length === 1) {
      await this.inspectPreparedImage(prior[0].Id, op);
      return prior[0].Id;
    }
    const query = new URLSearchParams({
      dockerfile: 'Dockerfile',
      pull: '0',
      networkmode: 'none',
      rm: '1',
      forcerm: '1',
      labels: JSON.stringify(labels),
    });
    const events = await this.transport.requestBytes(
      'POST',
      '/build?' + query,
      Readable.from(
        artifactImageContext(directory, manifest.files, this.options.runnerImage, manifest),
      ),
      { 'Content-Type': 'application/x-tar' },
    );
    this.live();
    const ids = events.flatMap((event) => {
      const id = (event as { aux?: { ID?: unknown } }).aux?.ID;
      return typeof id === 'string' ? [id] : [];
    });
    if (ids.length !== 1) {
      throw new Error('image_build_identity');
    }
    await this.inspectPreparedImage(ids[0], op);
    return ids[0];
  }
  containerBody(op: MvpOperation): ContainerRecipe {
    if (!op.image_id || !/^sha256:[a-f0-9]{64}$/.test(op.image_id)) {
      throw new Error('image_identity');
    }
    return {
      Image: op.image_id,
      User: '1000:1000',
      Env: ['NODE_ENV=production'],
      Labels: this.labels(op, 'app'),
      HostConfig: {
        Init: true,
        Memory: 256 * 1024 * 1024,
        NanoCpus: 500000000,
        PidsLimit: 64,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=33554432' },
        NetworkMode: this.resource('apps'),
        RestartPolicy: { Name: 'no' },
        Mounts: [
          { Type: 'volume', Source: this.resource('appdata'), Target: '/data', ReadOnly: false },
          {
            Type: 'volume',
            Source: this.resource('runtime-secrets'),
            Target: '/run/casimir',
            ReadOnly: true,
            VolumeOptions: { Subpath: op.id },
          },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { [this.resource('apps')]: {} } },
    };
  }
  jobBody(
    op: MvpOperation,
    action: string,
    jobId: string,
    release: MvpOperation = op,
    parameters: Record<string, unknown> = {},
  ): ContainerRecipe {
    if (
      !/^[a-f0-9]{32}$/.test(jobId) ||
      !['state', 'plan', 'apply', 'backup', 'restore', 'compatibility'].includes(action)
    ) {
      throw new Error('job_identity');
    }
    const body = this.containerBody({ ...op, image_id: release.image_id });
    body.Entrypoint = ['node', '/runner/job.mjs'];
    body.Cmd = [];
    body.Labels = {
      ...this.labels(op, 'job'),
      'org.casimir.job': jobId,
      'org.casimir.action': action,
      'org.casimir.image-owner': release.id,
      'org.casimir.runtime-id': parseRuntimeDescriptor(release.runtime).runtimeId,
    };
    body.HostConfig.NetworkMode = 'none';
    delete body.NetworkingConfig;
    body.HostConfig.Mounts = [
      {
        Type: 'volume',
        Source: this.resource('jobs'),
        Target: '/run/casimir',
        ReadOnly: true,
        VolumeOptions: { Subpath: jobId },
      },
      {
        Type: 'volume',
        Source: this.resource('jobs'),
        Target: '/output',
        ReadOnly: false,
        VolumeOptions: { Subpath: jobId + '/output' },
      },
      { Type: 'volume', Source: this.resource('snapshots'), Target: '/snapshots', ReadOnly: false },
    ];
    if (action === 'restore' || parameters.path === '/data/app.sqlite') {
      body.HostConfig.Mounts.push({
        Type: 'volume',
        Source: this.resource('appdata'),
        Target: '/data',
        ReadOnly: action === 'backup' || action === 'state',
      });
    }
    return body;
  }
  private assertBody(
    container: ContainerInspect | null,
    body: ContainerRecipe,
  ): asserts container is ContainerInspect {
    if (!container || container.Image !== body.Image || container.Config?.User !== body.User) {
      throw new Error('resource_recipe');
    }
    for (const [key, value] of Object.entries(body.Labels)) {
      if (container.Config?.Labels?.[key] !== value) {
        throw new Error('resource_ownership');
      }
    }
    const h = container.HostConfig,
      b = body.HostConfig;
    for (const key of [
      'Memory',
      'NanoCpus',
      'PidsLimit',
      'ReadonlyRootfs',
      'NetworkMode',
      'Init',
    ] as const) {
      if (h?.[key] !== b[key]) {
        throw new Error('resource_recipe');
      }
    }
    if (
      !h.CapDrop?.includes('ALL') ||
      !h.SecurityOpt?.includes('no-new-privileges:true') ||
      JSON.stringify(h.Tmpfs) !== JSON.stringify(b.Tmpfs) ||
      Object.keys(h.PortBindings ?? {}).length ||
      h.Privileged ||
      h.Binds?.length
    ) {
      throw new Error('resource_recipe');
    }
    if (h.Mounts?.length !== b.Mounts.length) {
      throw new Error('resource_recipe');
    }
    for (const expected of b.Mounts) {
      const mount = h.Mounts.find((m) => m.Target === expected.Target);
      if (
        !mount ||
        (['Type', 'Source'] as const).some((key) => mount[key] !== expected[key]) ||
        Boolean(mount.ReadOnly) !== expected.ReadOnly ||
        mount.VolumeOptions?.Subpath !== expected.VolumeOptions?.Subpath
      ) {
        throw new Error('resource_recipe');
      }
    }
    const image = this.imageConfigs.get(body.Image);
    if (!image) {
      throw new Error('image_unverified');
    }
    const env = new Map<string, string>((image.Env ?? []).map((s: string) => [s.split('=')[0], s]));
    for (const s of body.Env) {
      env.set(s.split('=')[0], s);
    }
    if (
      JSON.stringify([...env.values()].sort()) !==
        JSON.stringify([...container.Config.Env].sort()) ||
      JSON.stringify(container.Config.Entrypoint) !==
        JSON.stringify(body.Entrypoint ?? image.Entrypoint) ||
      JSON.stringify(container.Config.Cmd ?? []) !== JSON.stringify(body.Cmd ?? image.Cmd ?? [])
    ) {
      throw new Error('resource_recipe');
    }
    const networks = Object.keys(container.NetworkSettings.Networks ?? {});
    if (networks.length !== 1 || networks[0] !== b.NetworkMode) {
      throw new Error('resource_network');
    }
  }
  private async createOrRead(name: string, body: ContainerRecipe): Promise<ContainerInspect> {
    this.live();
    let container = await this.inspectContainer(name);
    if (!container) {
      const result = await this.transport.request('POST', '/containers/create?name=' + name, body);
      container = await this.inspectContainer(result.Id);
    }
    this.assertBody(container, body);
    return container;
  }
  async startApp(op: MvpOperation): Promise<string> {
    this.live();
    await this.inspectPreparedImage(op.image_id!, op);
    const container = await this.createOrRead(this.scope + '-app-' + op.id, this.containerBody(op));
    if (!container.State.Running) {
      await this.transport.request('POST', `/containers/${container.Id}/start`);
    }
    return container.Id;
  }
  async createStoppedApp(op: MvpOperation): Promise<string> {
    this.live();await this.inspectPreparedImage(op.image_id!,op);
    const container=await this.createOrRead(this.scope+'-app-'+op.id,this.containerBody(op));
    if(container.State.Running)throw new Error('restore_writer_already_running');
    return container.Id;
  }
  async stopApp(op: MvpOperation, id: string): Promise<void> {
    this.live();
    await this.inspectPreparedImage(op.image_id!, op);
    const c = await this.inspectContainer(id);
    if (!c) {
      return;
    }
    this.assertBody(c, this.containerBody(op));
    if (c.State.Running) {
      await this.transport.request('POST', `/containers/${c.Id}/stop?t=10`, undefined, 15000);
    }
    if ((await this.inspectContainer(id))?.State.Running) {
      throw new Error('writer_running');
    }
  }
  async privateProbe(op: MvpOperation, id: string): Promise<void> {
    await this.inspectPreparedImage(op.image_id!, op);
    for (let i = 0; i < 40; i++) {
      this.live();
      const c = await this.inspectContainer(id);
      this.assertBody(c, this.containerBody(op));
      if (!c.State.Running) {
        if (i > 2) {
          throw new Error('candidate_failed');
        }
        await delay(100);
        continue;
      }
      const ip = c.NetworkSettings?.Networks?.[this.resource('apps')]?.IPAddress;
      if (typeof ip !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        throw new Error('resource_network');
      }
      try {
        const response = await fetch(`http://${ip}:3000/_casimir/identity`, {
          signal: AbortSignal.timeout(1500),
        });
        const identity = (await response.json()) as Record<string, unknown>;
        if (
          !response.ok ||
          identity.projectId !== op.project_id ||
          identity.deploymentId !== op.deployment_id ||
          identity.artifactId !== op.artifact_id
        ) {
          throw new Error('candidate_failed');
        }
        if (
          (await fetch(`http://${ip}:3000/`, { signal: AbortSignal.timeout(1500) })).status >= 500
        ) {
          throw new Error('candidate_failed');
        }
        return;
      } catch {
        await delay(100);
      }
    }
    throw new Error('candidate_failed');
  }
  async runJob(
    op: MvpOperation,
    action: string,
    jobId: string,
    parameters: Record<string, unknown>,
    release: MvpOperation = op,
  ): Promise<Record<string, unknown>> {
    this.live();
    await this.inspectPreparedImage(release.image_id!, release);
    const directory = join('/jobs', jobId);
    await mkdir(join(directory, 'output'), { recursive: true, mode: 0o700 });
    const data = canonicalJson({ ...parameters, action });
    try {
      const fd = await open(join(directory, 'job.json'), 'wx', 0o400);
      try {
        await fd.writeFile(data);
        await fd.sync();
      } finally {
        await fd.close();
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        canonicalJson(JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'))) !== data
      ) {
        throw new Error('job_conflict');
      }
    }
    const body = this.jobBody(op, action, jobId, release, parameters),
      c = await this.createOrRead(this.scope + '-job-' + jobId, body);
    if (!c.State.Running && c.State.Status === 'created') {
      await this.transport.request('POST', `/containers/${c.Id}/start`);
    }
    return this.waitForJob(c, body, directory);
  }
  private async stopJobContainer(
    container: ContainerInspect,
    body: ContainerRecipe,
  ): Promise<void> {
    this.live();
    const current = await this.inspectContainer(container.Id);
    this.assertBody(current, body);
    if (current.State.Running) {
      await this.transport.request('POST', `/containers/${current.Id}/stop?t=2`, undefined, 5000);
    }
    const stopped = await this.inspectContainer(container.Id);
    this.assertBody(stopped, body);
    if (stopped.State.Running) {
      throw new Error('job_still_running');
    }
  }
  private async waitForJob(
    c: ContainerInspect,
    body: ContainerRecipe,
    directory: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + Math.min(60000, Math.max(1, this.options.jobTimeoutMs ?? 60000));
    while (Date.now() < deadline) {
      this.live();
      const current = await this.inspectContainer(c.Id);
      this.assertBody(current, body);
      if (!current.State.Running && current.State.Status !== 'created') {
        if (current.State.ExitCode !== 0) {
          throw new Error('job_failed');
        }
        const output = join(directory, 'output/result.json');
        if ((await stat(output)).size > 2 * 1024 * 1024) {
          throw new Error('job_result_limit');
        }
        const result: unknown = JSON.parse(await readFile(output, 'utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('job_result_invalid');
        }
        return result as Record<string, unknown>;
      }
      await delay(100);
    }
    await this.stopJobContainer(c, body);
    throw new Error('job_timeout');
  }
  async cleanupOperationJobs(
    op: MvpOperation,
    jobs: ReadonlyArray<MvpCleanupJob>,
  ): Promise<Array<string>> {
    this.live();
    if (!['succeeded', 'failed'].includes(op.phase)) {
      throw new Error('cleanup_phase');
    }
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          'org.casimir.task=' + (this.options.installationId ? 'c1' : 'mvp-a'),
          'org.casimir.scope=' + this.scope,
          'org.casimir.role=job',
          'org.casimir.operation=' + op.id,
        ],
      }),
    );
    const containers = await this.transport.request(
      'GET',
      '/containers/json?all=1&filters=' + filters,
    );
    if (!Array.isArray(containers)) {
      throw new Error('job_inventory');
    }
    const removed: Array<string> = [];
    for (const item of containers) {
      const c = await this.inspectContainer(item.Id);
      if (!c) {
        continue;
      }
      const record = jobs.find((job) => job.id === c.Config?.Labels?.['org.casimir.job']);
      if (!record || c.Name !== '/' + this.scope + '-job-' + record.id) {
        throw new Error('job_ownership');
      }
      await this.inspectPreparedImage(record.release.image_id!, record.release);
      const body = this.jobBody(op, record.action, record.id, record.release, record.parameters);
      this.assertBody(c, body);
      await this.stopJobContainer(c, body);
      this.live();
      await this.transport.request('DELETE', `/containers/${c.Id}?v=0`);
      removed.push(c.Id);
    }
    return removed;
  }
  async closeProxy(): Promise<void> {
    if (!this.options.installationId) throw new Error('installation_context_required');
    await this.reloadProxy(true);
  }
  async reloadProxy(closed = false): Promise<void> {
    this.live();
    const proxy = await this.inspectContainer(this.scope + '-app-ingress');
    if (
      !this.owned(proxy?.Config?.Labels) ||
      proxy?.Config.Labels['org.casimir.role'] !== 'app-ingress'
    ) {
      throw new Error('ingress_ownership');
    }
    const e = await this.transport.request('POST', `/containers/${proxy.Id}/exec`, {
      Cmd: this.options.installationId
        ? ['sh', '-ec', `cp ${closed ? '/config/closed.conf' : '/routes/route.conf'} /tmp/active.conf; nginx -c /tmp/active.conf -s reload`]
        : ['nginx', '-c', '/routes/route.conf', '-s', 'reload'],
      AttachStdout: false,
      AttachStderr: false,
    });
    await this.transport.request('POST', `/exec/${e.Id}/start`, { Detach: true });
    for (let i = 0; i < 30; i++) {
      this.live();
      const result = await this.transport.request('GET', `/exec/${e.Id}/json`);
      if (!result.Running) {
        if (result.ExitCode !== 0) {
          throw new Error('ingress_reload');
        }
        return;
      }
      await delay(100);
    }
    throw new Error('ingress_timeout');
  }
  async prepareSecrets(op: MvpOperation, keys: ReadonlyArray<string>): Promise<string> {
    this.live();
    const bytes = await readFile('/config/runtime-env.json');
    const values = selectRuntimeSecrets(keys, JSON.parse(bytes.toString('utf8')));
    const directory = join('/runtime', op.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = JSON.stringify({
      projectId: op.project_id,
      deploymentId: op.deployment_id,
      artifactId: op.artifact_id,
      ...(this.options.appOrigin ? {origin: this.options.appOrigin} : {}),
    });
    for (const [name, data] of [
      ['env.json', JSON.stringify(values)],
      ['release.json', release],
    ]) {
      try {
        const fd = await open(join(directory, name), 'wx', 0o400);
        try {
          await fd.writeFile(data);
          await fd.sync();
        } finally {
          await fd.close();
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(join(directory, name), 'utf8')) !== data
        ) {
          throw new Error('runtime_secret_revision');
        }
      }
    }
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return createHash('sha256').update(bytes).digest('hex');
  }
  async assertSingleWriter(op: MvpOperation | null): Promise<void> {
    this.live();
    await this.inspectSingleWriter(op);
  }
  async inspectSingleWriter(op: MvpOperation | null): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ volume: [this.resource('appdata')] }));
    const containers = await this.transport.request('GET', '/containers/json?filters=' + filters);
    if (!Array.isArray(containers)) {
      throw new Error('writer_inventory');
    }
    let writers = 0;
    for (const item of containers) {
      const c = await this.inspectContainer(item.Id);
      if (!c?.State.Running || !c.Mounts?.some((m) => m.Name === this.resource('appdata') && m.RW)) {
        continue;
      }
      if (!op || c.Id !== op.candidate_id) {
        throw new Error('writer_conflict');
      }
      await this.inspectPreparedImage(op.image_id!, op);
      this.assertBody(c, this.containerBody(op));
      writers++;
    }
    if (writers !== (op ? 1 : 0)) {
      throw new Error('writer_inventory');
    }
  }
  async observeIngress(op: MvpOperation | null): Promise<void> {
    await this.inspectIngress(op, () => this.live());
  }
  async inspectIngress(op: MvpOperation | null, assertLive: () => void = () => {}): Promise<void> {
    for (let i = 0; i < 40; i++) {
      assertLive();
      try {
        const response = await fetch(
          'http://' + this.scope + '-app-ingress:8080/?casimir_probe=' + Date.now(),
          { headers: { Connection: 'close', ...(this.options.appOrigin ? {Host: new URL(this.options.appOrigin).host} : {}) }, signal: AbortSignal.timeout(1500) },
        );
        if (
          op
            ? response.status < 500 &&
              response.headers.get('x-casimir-deployment') === op.deployment_id &&
              response.headers.get('x-casimir-image') === op.image_id &&
              response.headers.get('x-casimir-artifact') === op.artifact_id
            : response.status === 503
        ) {
          return;
        }
      } catch {
        /* Retry while ingress workers reload. */
      }
      await delay(100);
    }
    throw new Error('ingress_observation');
  }
}
