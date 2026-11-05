import {
  platformProjectHostname,
  readPlatformApplication,
  type PlatformApplicationProject,
} from '@void/platform';
import type { ApiEnv } from './env.ts';

type ProjectUrlBindings = Pick<ApiEnv['Bindings'], 'PLATFORM_APPLICATION' | 'SITE_DOMAIN'>;

export function projectUrl(project: PlatformApplicationProject, env: ProjectUrlBindings): string {
  return `https://${platformProjectHostname(project, readPlatformApplication(env))}`;
}

export function projectWithUrl<T extends PlatformApplicationProject>(
  project: T,
  env: ProjectUrlBindings,
): T & { url?: string } {
  return env.PLATFORM_APPLICATION ? { ...project, url: projectUrl(project, env) } : project;
}
