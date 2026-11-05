import { writeFile, rename } from 'node:fs/promises';
import { DockerTransport, createEngine } from './docker-engine.ts';
import { loadProfile, aliases } from './profile.ts';
import { RouteStore } from './routing.ts';
const path = process.env.CASIMIR_EXECUTION_PROFILE ?? '/config/profile.json';
try {
  const command = process.argv[2];
  if (command === 'prepare-profile') {
    const transport = new DockerTransport('/var/run/docker.sock');
    const images: Record<string, string> = {};
    for (const alias of aliases) {
      const tag = alias === 'demo-broken' ? 'broken' : alias.slice(5);
      const image = await transport.request('GET', `/images/casimir-execution-demo:${tag}/json`);
      if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw Error();
      images[alias] = image.Id;
    }
    await writeFile(
      path + '.next',
      JSON.stringify(
        {
          recipeVersion: 1,
          scope: 'casimir-execution-poc',
          controlPort: 4283,
          appPort: 4284,
          images,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o644 },
    );
    loadProfile(path + '.next');
    await rename(path + '.next', path);
    console.log('Immutable image catalog prepared');
  } else if (command === 'init-routes') await new RouteStore('/routes').initialize();
  else if (command === 'verify-environment')
    await createEngine({
      socketPath: '/var/run/docker.sock',
      profile: loadProfile(path),
      preparation: true,
    }).verifyEnvironment();
  else if (command === 'probe-loopback') {
    const route = await new RouteStore('/routes').read();
    await createEngine({
      socketPath: '/var/run/docker.sock',
      profile: loadProfile(path),
      preparation: true,
    }).runLoopbackProbe(route.target, route);
    console.log('Actual host loopback verified');
  } else throw Error();
} catch {
  console.error('Casimir trusted preparation failed');
  process.exitCode = 1;
}
