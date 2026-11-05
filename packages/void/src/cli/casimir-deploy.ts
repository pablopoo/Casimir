import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertCasimirRuntime,
  parseRuntimeDescriptor,
  type RuntimeDescriptor,
} from '@void/deploy-core';
import { join } from 'pathslash';
import { resolveCasimirProfile } from '../casimir/profile.ts';
import { readConfig } from '../config.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { buildCasimirArtifact } from './casimir-artifact.ts';
import { CasimirClient, type CasimirReceipt } from './casimir-client.ts';
import {
  readCasimirLink,
  readCasimirCredential,
  writeCasimirJson,
  type CasimirLink,
} from './casimir-connect.ts';
import type { RunDeployOptions } from './deploy-types.ts';
type Retry = {
  origin: string;
  projectId: string;
  key: string;
  artifactId: string;
  artifactHash: string;
  runtime: RuntimeDescriptor;
  receipt?: CasimirReceipt;
  finished: boolean;
};
function pending(root: string): Retry | null {
  const path = join(root, '.void/casimir.retry.json');
  if (!existsSync(path)) {
    return null;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('unsafe_retry_record');
  }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.finished !== 'boolean' ||
    !/^proj_[a-z0-9]{12}$/.test(value.projectId) ||
    typeof value.origin !== 'string' ||
    typeof value.key !== 'string' ||
    !/^car_[a-z0-9]{12}$/.test(value.artifactId) ||
    !/^[a-f0-9]{64}$/.test(value.artifactHash)
  ) {
    throw new Error('invalid_retry_record');
  }
  parseRuntimeDescriptor(value.runtime);
  return value;
}
export async function runCasimirDeploy(
  root: string,
  options: RunDeployOptions = {},
): Promise<void> {
  if (options.dir || options.spa || options.provision || options.requireEmail || options.atomic) {
    throw new Error('unsupported_casimir_deploy_option');
  }
  const config = await readConfig(root);
  if (!resolveCasimirProfile(config)) {
    throw new Error('casimir_native_profile_required');
  }
  let link = readCasimirLink(root);
  const client = new CasimirClient(link.origin, readCasimirCredential(link.origin), {
    expected: link.runtime,
  });
  const runtime = await client.connect();
  if (link.projectId && options.projectSlug && options.projectSlug !== link.slug) {
    throw new Error('casimir_project_target_changed');
  }
  if (!link.projectId) {
    if (!options.projectSlug) {
      throw new Error('casimir: --project <slug> is required for the first deployment');
    }
    let project = await client.findProjectBySlug(options.projectSlug);
    if (!project) {
      project = await client.createProject(options.projectSlug);
    }
    if (
      typeof project.id !== 'string' ||
      !/^proj_[a-z0-9]{12}$/.test(project.id) ||
      project.slug !== options.projectSlug
    ) {
      throw new Error('protocol_project');
    }
    link = { ...link, projectId: project.id, slug: options.projectSlug };
    writeCasimirJson(join(root, '.void/casimir.json'), link);
  }
  const projectId = link.projectId!;
  const project = await client.project(projectId);
  if (project.id !== projectId || project.slug !== link.slug) {
    throw new Error('casimir_project_target_changed');
  }
  let retry = pending(root);
  if (retry && !retry.finished) {
    if (retry.origin !== link.origin || retry.projectId !== projectId) {
      throw new Error('casimir_retry_target_changed');
    }
    assertCasimirRuntime(retry.runtime, runtime);
  } else {
    if (!options.skipBuild) {
      const result = spawnSync('pnpm', ['exec', 'vp', 'build'], {
        cwd: root,
        env: buildEnv(undefined, { localBinRoot: root }),
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        throw new Error('casimir_build_failed');
      }
    }
    const artifact = await buildCasimirArtifact(root, runtime);
    try {
      const { artifactId } = await client.upload(projectId, artifact.path);
      retry = {
        origin: link.origin,
        projectId,
        key: randomUUID(),
        artifactId,
        artifactHash: artifact.sha256,
        runtime,
        finished: false,
      };
      writeCasimirJson(join(root, '.void/casimir.retry.json'), retry, true);
    } finally {
      await rm(join(artifact.path, '..'), { recursive: true, force: true });
    }
  }
  if (!retry.receipt) {
    retry.receipt = await client.deploy(projectId, retry.artifactId, retry.key);
    writeCasimirJson(join(root, '.void/casimir.retry.json'), retry, true);
  }
  console.log(
    JSON.stringify({
      operationId: retry.receipt.operationId,
      deploymentId: retry.receipt.deploymentId,
    }),
  );
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const view = await client.operation(projectId, retry.receipt.operationId);
    if (view.phase === 'succeeded') {
      const observed = view.verifiedServing as Record<string, unknown> | null;
      const desired = view.desired as Record<string, unknown> | null;
      if (
        !observed ||
        !desired ||
        observed.deploymentId !== retry.receipt.deploymentId ||
        observed.artifactId !== retry.artifactId ||
        observed.imageId !== desired.imageId ||
        typeof observed.imageId !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(observed.imageId)
      ) {
        throw new Error('serving_identity_unverified');
      }
      retry.finished = true;
      writeCasimirJson(join(root, '.void/casimir.retry.json'), retry, true);
      console.log(JSON.stringify({ phase: view.phase, verifiedServing: observed }));
      return;
    }
    if (view.phase === 'failed') {
      retry.finished = true;
      writeCasimirJson(join(root, '.void/casimir.retry.json'), retry, true);
      throw new Error('casimir_deployment_failed');
    }
    if (view.phase === 'recovery_required') {
      throw new Error('casimir_recovery_required');
    }
    await delay(500);
  }
  throw new Error('casimir_operation_pending');
}
export async function runCasimirProject(
  root: string,
  subcommand: string,
  name?: string,
): Promise<void> {
  let link: CasimirLink = readCasimirLink(root);
  const client = new CasimirClient(link.origin, readCasimirCredential(link.origin), {
    expected: link.runtime,
  });
  await client.connect();
  if (subcommand === 'link') {
    if (pending(root)?.finished === false) {
      throw new Error('casimir_operation_pending');
    }
    if (!name) {
      throw new Error('casimir_project_slug_required');
    }
    const project = await client.findProjectBySlug(name);
    if (!project || typeof project.id !== 'string') {
      throw new Error('casimir_project_not_found');
    }
    link = { ...link, projectId: project.id, slug: name };
    writeCasimirJson(join(root, '.void/casimir.json'), link);
    return;
  }
  if (subcommand !== 'status') {
    throw new Error('unsupported_casimir_project_command');
  }
  if (!link.projectId || (name && name !== link.slug)) {
    throw new Error('casimir_project_target_changed');
  }
  console.log(JSON.stringify(await client.deployments(link.projectId), null, 2));
}
