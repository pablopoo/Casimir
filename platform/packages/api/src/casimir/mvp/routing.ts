import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
export type MvpTarget = {
  projectId: string;
  deploymentId: string;
  artifactId: string;
  containerId: string;
  imageId: string;
};
export type MvpRoute = { target: MvpTarget | null; fingerprint: string };
function validate(target: MvpTarget): void {
  if (
    !target ||
    Object.keys(target).sort().join(',') !==
      'artifactId,containerId,deploymentId,imageId,projectId' ||
    !/^proj_[a-z0-9]{12}$/.test(target.projectId) ||
    !/^dpl_[a-z0-9]{12}$/.test(target.deploymentId) ||
    !/^car_[a-z0-9]{12}$/.test(target.artifactId) ||
    !/^sha256:[a-f0-9]{64}$/.test(target.imageId) ||
    !/^[a-f0-9]{64}$/.test(target.containerId)
  ) {
    throw new Error('route_invalid');
  }
}
export function mvpRouteConfig(target: MvpTarget | null): string {
  if (target) {
    validate(target);
  }
  const identity = Buffer.from(JSON.stringify(target)).toString('base64');
  const upstream = target
    ? `set $casimir_target ${target.containerId.slice(0, 12)}:3000;
 proxy_pass http://$casimir_target$request_uri;
 proxy_set_header Host $http_host;
 proxy_hide_header X-Casimir-Deployment; proxy_hide_header X-Casimir-Image; proxy_hide_header X-Casimir-Artifact;
 add_header X-Casimir-Deployment ${target.deploymentId} always;
 add_header X-Casimir-Image ${target.imageId} always;
 add_header X-Casimir-Artifact ${target.artifactId} always;
 proxy_connect_timeout 2s; proxy_read_timeout 5s; proxy_buffering off;`
    : 'return 503;';
  return `# casimir-mvp-target ${identity}
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {}
http {
 access_log off;
 client_body_temp_path /tmp/client_body; proxy_temp_path /tmp/proxy;
 fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;
 resolver 127.0.0.11 valid=1s ipv6=off;
 server { listen 8080; client_max_body_size 16k;
  location ^~ /_casimir/ { return 404; }
  location / { ${upstream} }
 }
}
`;
}
export class MvpRouteStore {
  constructor(readonly directory: string) {}
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await this.write(null, true);
    }
  }
  async read(): Promise<MvpRoute> {
    const text = await readFile(join(this.directory, 'route.conf'), 'utf8');
    try {
      if (text.length > 16384) {
        throw Error();
      }
      const match = /^# casimir-mvp-target ([A-Za-z0-9+/=]+)\n/.exec(text);
      if (!match) {
        throw Error();
      }
      const target = JSON.parse(
        Buffer.from(match[1], 'base64').toString('utf8'),
      ) as MvpTarget | null;
      if (text !== mvpRouteConfig(target)) {
        throw Error();
      }
      return { target, fingerprint: createHash('sha256').update(text).digest('hex') };
    } catch {
      throw new Error('route_invalid');
    }
  }
  async replace(expected: MvpRoute, target: MvpTarget | null): Promise<MvpRoute> {
    if ((await this.read()).fingerprint !== expected.fingerprint) {
      throw new Error('route_conflict');
    }
    await this.write(target);
    return this.read();
  }
  private async write(target: MvpTarget | null, initial = false): Promise<void> {
    const content = mvpRouteConfig(target);
    // Interrupted attempts may leave partial files. Never reuse or remove them:
    // each write owns only this unpredictable exclusively-created temp name.
    const next = join(this.directory, 'route.conf.' + randomBytes(16).toString('hex') + '.next');
    const fd = await open(next, 'wx', 0o644);
    try {
      try {
        await fd.writeFile(content);
        await fd.sync();
      } finally {
        await fd.close();
      }
      if (initial) {
        // Publish a complete fsynced file atomically without replacing an
        // operator's or another initializer's pre-existing canonical route.
        await link(next, join(this.directory, 'route.conf'));
      } else {
        await rename(next, join(this.directory, 'route.conf'));
      }
    } finally {
      await rm(next, { force: true });
    }
    const dir = await open(this.directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
