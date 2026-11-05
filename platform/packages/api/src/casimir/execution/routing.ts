import { readFile, open, rename, mkdir, access, chown } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './profile.ts';
import type { RouteIdentity, Target } from './types.ts';
export function validateTarget(t: Target) {
  if (
    !t ||
    !/^proj_[a-z0-9]{12}$/.test(t.projectId) ||
    !/^dpl_[a-z0-9]{12}$/.test(t.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(t.containerId) ||
    !/^sha256:[a-f0-9]{64}$/.test(t.imageId) ||
    !['v1', 'v2', 'broken'].includes(t.version)
  )
    throw new Error('route invalid');
}
export function routeConfig(target: Target | null) {
  if (target) validateTarget(target);
  const canonical = target
    ? {
        projectId: target.projectId,
        deploymentId: target.deploymentId,
        containerId: target.containerId,
        imageId: target.imageId,
        version: target.version,
      }
    : null;
  const identity = Buffer.from(JSON.stringify(canonical)).toString('base64');
  const location = target
    ? `set $casimir_target ${target.containerId.slice(0, 12)}:3000;
      proxy_pass http://$casimir_target$request_uri;
      proxy_hide_header X-Casimir-Deployment;
      proxy_hide_header X-Casimir-Image;
      proxy_hide_header X-Casimir-Project;
      add_header X-Casimir-Deployment ${target.deploymentId} always;
      add_header X-Casimir-Image ${target.imageId} always;
      add_header X-Casimir-Project ${target.projectId} always;
      proxy_connect_timeout 2s;
      proxy_read_timeout 2s;
      proxy_buffering off;`
    : 'return 503;';
  return `# casimir-target ${identity}\npid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  resolver 127.0.0.11 valid=1s ipv6=off;
  server { listen 8080; client_max_body_size 16k;
    location / { ${location} }
  }
}\n`;
}
export class RouteStore {
  constructor(private directory: string) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      await access(join(this.directory, 'route.conf'));
      await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.write(null);
    }
    if (process.getuid?.() === 0) {
      await chown(this.directory, 1000, 1000);
      await chown(join(this.directory, 'route.conf'), 1000, 1000);
    }
  }
  async read(): Promise<RouteIdentity> {
    try {
      const text = await readFile(join(this.directory, 'route.conf'), 'utf8');
      if (text.length > 16384) throw Error();
      const match = /^# casimir-target ([A-Za-z0-9+/=]+)\n/.exec(text);
      if (!match) throw Error();
      const target = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Target | null;
      if (text !== routeConfig(target)) throw Error();
      return { target, fingerprint: digest(text), observedAt: new Date().toISOString() };
    } catch {
      throw new Error('route invalid');
    }
  }
  async replace(expected: RouteIdentity, target: Target | null): Promise<RouteIdentity> {
    const current = await this.read();
    if (current.fingerprint !== expected.fingerprint) throw new Error('route conflict');
    await this.write(target);
    return this.read();
  }
  private async write(target: Target | null) {
    const tmp = join(this.directory, 'route.conf.next'),
      file = await open(tmp, 'w', 0o644);
    try {
      await file.writeFile(routeConfig(target));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, join(this.directory, 'route.conf'));
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
