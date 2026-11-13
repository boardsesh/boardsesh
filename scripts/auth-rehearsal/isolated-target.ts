import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeDocker, pinnedDocker, type DockerCommand } from './docker';
import {
  attestIsolatedNamespace,
  type NamespaceExpectation,
  type NamespaceResource,
  type IsolatedNamespace,
} from './namespace-guard';
import { requireBuiltRuntimeImage, type RuntimeImage } from './runtime-image';
import {
  createRehearsalSecrets,
  REHEARSAL_CONTAINER_LABEL,
  REHEARSAL_POSTGRES_IMAGE,
  RehearsalSafetyError,
} from './target-guard';
import { REHEARSAL_REDIS_IMAGE } from './owned-target';

const createdTargets = new WeakSet<object>();
export function requireCreatedIsolatedTarget(target: object): void {
  if (!createdTargets.has(target)) throw new RehearsalSafetyError('OWNED_ISOLATED_TARGET_RECEIPT_REQUIRED');
}
function record(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new RehearsalSafetyError('NAMESPACE_METADATA_REFUSED');
  return candidate as Record<string, unknown>;
}
function one(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new RehearsalSafetyError('NAMESPACE_METADATA_REFUSED');
  return record(parsed[0]);
}
function text(candidate: unknown): string {
  if (typeof candidate !== 'string') throw new RehearsalSafetyError('NAMESPACE_METADATA_REFUSED');
  return candidate;
}
function strings(candidate: unknown): string[] {
  if (candidate == null) return [];
  if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== 'string'))
    throw new RehearsalSafetyError('NAMESPACE_METADATA_REFUSED');
  return candidate as string[];
}
function bindings(candidate: unknown): number {
  if (candidate == null) return 0;
  return Object.values(record(candidate)).reduce<number>((count, entries) => {
    if (entries === null) return count;
    if (!Array.isArray(entries)) throw new RehearsalSafetyError('NAMESPACE_METADATA_REFUSED');
    return count + entries.length;
  }, 0);
}
function resource(container: Record<string, unknown>): NamespaceResource {
  const config = record(container.Config);
  const host = record(container.HostConfig);
  const network = record(container.NetworkSettings);
  const mounts = container.Mounts;
  if (!Array.isArray(mounts)) throw new RehearsalSafetyError('NAMESPACE_METADATA_REFUSED');
  if (bindings(host.PortBindings) !== 0) throw new RehearsalSafetyError('OWNED_NAMESPACE_PUBLICATION_FORBIDDEN');
  return {
    id: text(container.Id),
    image: text(container.Image),
    name: text(container.Name),
    nonce: text(record(config.Labels)[REHEARSAL_CONTAINER_LABEL]),
    running: record(container.State).Running === true,
    networkMode: text(host.NetworkMode),
    networkIds: Object.values(record(network.Networks)).map((entry) => text(record(entry).NetworkID)),
    publishedBindings: bindings(network.Ports),
    requestedBindings: bindings(host.PortBindings),
    bindMounts: mounts.filter((mount) => record(mount).Type === 'bind').length,
    privileged: host.Privileged !== false,
    dns: strings(host.Dns),
    readOnly: host.ReadonlyRootfs === true,
    capDrop: strings(host.CapDrop),
    capAdd: strings(host.CapAdd),
  };
}

/** No SQL and no application starts until attest() succeeds for all three containers. */
export async function createIsolatedTarget(image: RuntimeImage, docker: DockerCommand = executeDocker) {
  requireBuiltRuntimeImage(image);
  const pinned = pinnedDocker(image.identity, docker);
  const secrets = createRehearsalSecrets();
  const nonce = randomBytes(16).toString('hex');
  const auditDirectory = fileURLToPath(new URL('../../.boardsesh/', import.meta.url));
  mkdirSync(auditDirectory, { recursive: true });
  if (!lstatSync(auditDirectory).isDirectory() || lstatSync(auditDirectory).isSymbolicLink())
    throw new RehearsalSafetyError('OWNED_CREATION_AUDIT_REFUSED');
  const auditPath = `${auditDirectory}auth-rehearsal-creation-${nonce}.json`;
  const actions: Readonly<Record<string, unknown>>[] = [];
  function audit(action: Readonly<Record<string, unknown>>) {
    actions.push({ createdAt: new Date().toISOString(), ...action });
    const pending = `${auditPath}.${randomBytes(8).toString('hex')}`;
    writeFileSync(
      pending,
      JSON.stringify(
        {
          purpose: 'Private cleanup evidence only; never an execution capability.',
          identity: image.identity,
          nonce,
          actions,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    renameSync(pending, auditPath);
  }
  async function immutableImage(reference: string) {
    const id = await pinned(['image', 'inspect', reference, '--format', '{{.Id}}']);
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new RehearsalSafetyError('PINNED_LOCAL_IMAGE_REQUIRED');
    return id;
  }
  const postgresImage = await immutableImage(REHEARSAL_POSTGRES_IMAGE);
  const redisImage = await immutableImage(REHEARSAL_REDIS_IMAGE);
  audit({ operation: 'network-create-intent', name: `boardsesh-auth-rehearsal-${nonce}`, internal: true });
  const networkId = await pinned([
    'network',
    'create',
    '--internal',
    '--label',
    `${REHEARSAL_CONTAINER_LABEL}=${nonce}`,
    `boardsesh-auth-rehearsal-${nonce}`,
  ]);
  if (!/^[a-f0-9]{64}$/.test(networkId)) throw new RehearsalSafetyError('OWNED_RESOURCE_ID_REQUIRED');
  audit({ operation: 'network-create-internal', networkId });
  async function run(
    service: 'postgres' | 'redis' | 'runtime',
    namespace: string,
    serviceImage: string,
    arguments_: string[],
    environment: Record<string, string> = {},
  ) {
    audit({
      operation: 'container-run-intent',
      service,
      name: `boardsesh-auth-rehearsal-${service}-${nonce}`,
      image: serviceImage,
      networkMode: namespace,
    });
    const id = await pinned(
      [
        'run',
        '--detach',
        '--pull=never',
        '--name',
        `boardsesh-auth-rehearsal-${service}-${nonce}`,
        '--label',
        `${REHEARSAL_CONTAINER_LABEL}=${nonce}`,
        '--network',
        namespace,
        '--security-opt',
        'no-new-privileges',
        ...arguments_,
        serviceImage,
        ...(service === 'redis'
          ? ['sh', '-c', 'exec redis-server --save "" --appendonly no --requirepass "$REHEARSAL_REDIS_PASSWORD"']
          : []),
      ],
      environment,
    );
    if (!/^[a-f0-9]{64}$/.test(id)) throw new RehearsalSafetyError('OWNED_RESOURCE_ID_REQUIRED');
    audit({ operation: 'container-run', service, id, image: serviceImage, networkMode: namespace });
    return Object.freeze({ id, image: serviceImage });
  }
  const postgres = await run(
    'postgres',
    networkId,
    postgresImage,
    [
      '--dns',
      '127.0.0.1',
      '--memory',
      '768m',
      '--cpus',
      '1',
      '--tmpfs',
      '/var/lib/postgresql:rw,size=536870912',
      '--env',
      'POSTGRES_USER=auth_rehearsal',
      '--env',
      'POSTGRES_DB=postgres',
      '--env',
      'POSTGRES_PASSWORD',
    ],
    { POSTGRES_PASSWORD: secrets.postgresPassword },
  );
  const redis = await run(
    'redis',
    `container:${postgres.id}`,
    redisImage,
    ['--memory', '128m', '--cpus', '0.5', '--tmpfs', '/data:rw,size=67108864', '--env', 'REHEARSAL_REDIS_PASSWORD'],
    { REHEARSAL_REDIS_PASSWORD: secrets.redisPassword },
  );
  const runtime = await run('runtime', `container:${postgres.id}`, image.imageId, [
    '--read-only',
    '--cap-drop',
    'ALL',
    '--pids-limit',
    '128',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:rw,size=268435456,mode=1777',
  ]);
  const expected: NamespaceExpectation = Object.freeze({
    identity: image.identity,
    nonce,
    networkId,
    postgres,
    redis,
    runtime,
  });
  let disposed = false;
  async function attest(): Promise<IsolatedNamespace> {
    if (disposed) throw new RehearsalSafetyError('OWNED_TARGET_DISPOSED');
    const daemonId: unknown = JSON.parse(await pinned(['info', '--format', '{{json .ID}}']));
    const network = one(await pinned(['network', 'inspect', networkId]));
    return attestIsolatedNamespace(expected, {
      identity: { ...image.identity, daemonId: text(daemonId) },
      internal: network.Internal === true,
      networkId: text(network.Id),
      networkNonce: text(record(network.Labels)[REHEARSAL_CONTAINER_LABEL]),
      networkMemberIds: Object.keys(record(network.Containers)),
      postgres: resource(one(await pinned(['inspect', postgres.id]))),
      redis: resource(one(await pinned(['inspect', redis.id]))),
      runtime: resource(one(await pinned(['inspect', runtime.id]))),
      postgresNamespace: await pinned(['exec', postgres.id, 'readlink', '/proc/self/ns/net']),
      runtimeNamespace: await pinned(['exec', runtime.id, 'readlink', '/proc/self/ns/net']),
    });
  }
  const receipt = await attest();
  const target = Object.freeze({
    receipt,
    secrets,
    expected,
    attest,
    async dispose() {
      if (disposed) return;
      await attest();
      for (const container of [runtime, redis, postgres]) await pinned(['rm', '--force', container.id]);
      await pinned(['network', 'rm', networkId]);
      disposed = true;
      audit({ operation: 'owned-dispose-complete' });
    },
  });
  createdTargets.add(target);
  return target;
}
