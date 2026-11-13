import { randomBytes } from 'node:crypto';
import { executeDocker, inspectOwnedContainer, localDockerIdentity, pinnedDocker, type DockerCommand } from './docker';
import {
  createRehearsalSecrets,
  REHEARSAL_CONTAINER_LABEL,
  REHEARSAL_POSTGRES_IMAGE,
  RehearsalSafetyError,
  type ExpectedOwnedContainer,
  type OwnedLocalEndpoint,
  type RehearsalSecrets,
} from './target-guard';

export const REHEARSAL_REDIS_IMAGE = 'redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf';

export interface OwnedTarget {
  readonly runNonce: string;
  readonly secrets: RehearsalSecrets;
  readonly containers: Readonly<{ postgres: ExpectedOwnedContainer; redis: ExpectedOwnedContainer }>;
  readonly postgres: OwnedLocalEndpoint;
  readonly redis: OwnedLocalEndpoint;
  revalidate(): Promise<void>;
  dispose(): Promise<void>;
}

function identifier(serialized: string): string {
  if (!/^[a-f0-9]{64}$/.test(serialized)) throw new RehearsalSafetyError('OWNED_RESOURCE_ID_REQUIRED');
  return serialized;
}
async function imageId(docker: DockerCommand, reference: string): Promise<string> {
  let serialized: string;
  try {
    serialized = await docker(['image', 'inspect', reference, '--format', '{{.Id}}']);
  } catch {
    throw new RehearsalSafetyError('PINNED_LOCAL_IMAGE_REQUIRED');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(serialized)) throw new RehearsalSafetyError('PINNED_LOCAL_IMAGE_REQUIRED');
  return serialized;
}

/** Creates only fresh resources on a verified local daemon. Never accepts a URL or existing target. */
export async function createOwnedTarget(docker: DockerCommand = executeDocker): Promise<OwnedTarget> {
  const identity = await localDockerIdentity(docker);
  const pinned = pinnedDocker(identity, docker);
  // Resolve both immutable images before the first resource write. Pulling is an explicit separate operation.
  const postgresImageId = await imageId(pinned, REHEARSAL_POSTGRES_IMAGE);
  const redisImageId = await imageId(pinned, REHEARSAL_REDIS_IMAGE);
  const runNonce = randomBytes(16).toString('hex');
  const secrets = createRehearsalSecrets();
  const label = `${REHEARSAL_CONTAINER_LABEL}=${runNonce}`;
  const networkId = identifier(
    await pinned(['network', 'create', '--internal', '--label', label, `boardsesh-auth-rehearsal-${runNonce}`]),
  );
  const created: ExpectedOwnedContainer[] = [];
  let disposed = false;
  async function launch(service: 'postgres' | 'redis', image: string): Promise<OwnedLocalEndpoint> {
    const port = service === 'postgres' ? '5432' : '6379';
    const common = [
      'run',
      '--detach',
      '--pull=never',
      '--name',
      `boardsesh-auth-rehearsal-${service}-${runNonce}`,
      '--label',
      label,
      '--network',
      networkId,
      '--publish',
      `127.0.0.1::${port}`,
      '--memory',
      service === 'postgres' ? '768m' : '128m',
      '--cpus',
      service === 'postgres' ? '1' : '0.5',
      '--security-opt',
      'no-new-privileges',
    ];
    const arguments_ =
      service === 'postgres'
        ? [
            ...common,
            '--tmpfs',
            '/var/lib/postgresql:rw,size=536870912',
            '--env',
            'POSTGRES_USER=auth_rehearsal',
            '--env',
            'POSTGRES_DB=postgres',
            '--env',
            'POSTGRES_PASSWORD',
            image,
          ]
        : [
            ...common,
            '--tmpfs',
            '/data:rw,size=67108864',
            image,
            'redis-server',
            '--save',
            '',
            '--appendonly',
            'no',
            '--requirepass',
            secrets.redisPassword,
          ];
    const containerId = identifier(
      await pinned(arguments_, service === 'postgres' ? { POSTGRES_PASSWORD: secrets.postgresPassword } : undefined),
    );
    const expected = { service, identity, containerId, imageId: image, runNonce, networkId };
    created.push(expected);
    return (await inspectOwnedContainer(expected, docker)).endpoint;
  }
  async function dispose(): Promise<void> {
    if (disposed) return;
    // Reinspect all resources BEFORE the first deletion. Refuse any changed ownership/daemon metadata.
    for (const expected of created) await inspectOwnedContainer(expected, docker);
    for (const expected of created) await pinned(['rm', '--force', expected.containerId]);
    await pinned(['network', 'rm', networkId]);
    disposed = true;
  }
  try {
    const postgres = await launch('postgres', postgresImageId);
    const redis = await launch('redis', redisImageId);
    return Object.freeze({
      runNonce,
      secrets,
      containers: Object.freeze({ postgres: Object.freeze(created[0]), redis: Object.freeze(created[1]) }),
      postgres,
      redis,
      async revalidate() {
        if (disposed) throw new RehearsalSafetyError('OWNED_TARGET_DISPOSED');
        for (const expected of created) await inspectOwnedContainer(expected, docker);
      },
      dispose,
    });
  } catch (error) {
    // Do not blindly delete resources after a metadata refusal; report a fixed failure for manual inspection.
    throw new RehearsalSafetyError(
      `OWNED_TARGET_PREPARATION_FAILED:${error instanceof RehearsalSafetyError ? error.code : 'UNCLASSIFIED'}`,
    );
  }
}
