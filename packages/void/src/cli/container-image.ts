import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'pathslash';

function docker(args: Array<string>, quiet = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.WRANGLER_DOCKER_BIN ?? 'docker', args, {
      stdio: quiet ? 'ignore' : 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error('Sandbox image preparation failed. Start Docker and retry the deployment.'),
          ),
    );
  });
}

/** Build locally; the pinned cf uploader pushes this tag to the managed registry. */
export async function buildContainerImage(
  dockerfile: string,
  buildContext: string = dirname(dockerfile),
): Promise<{ localReference: string; dispose(): Promise<void> }> {
  const localReference = `void-sandbox-build:${randomUUID()}`;
  await docker([
    'build',
    '--platform',
    'linux/amd64',
    '--file',
    dockerfile,
    '--tag',
    localReference,
    buildContext,
  ]);
  return {
    localReference,
    dispose: () => docker(['image', 'rm', localReference], true).catch(() => {}),
  };
}
