import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  assertLocalDockerIdentity,
  ownedLocalEndpoint,
  RehearsalSafetyError,
  REHEARSAL_CONTAINER_LABEL,
  type ExpectedOwnedContainer,
  type LocalDockerIdentity,
  type OwnedContainerProof,
  type OwnedLocalEndpoint,
} from './target-guard';

export type DockerCommand = (
  arguments_: readonly string[],
  additions?: Readonly<Record<string, string>>,
) => Promise<string>;
const executeFile = promisify(execFile);

/** Local CLI metadata stays private; errors never copy argv, secrets or daemon responses. */
export const executeDocker: DockerCommand = async (arguments_, additions = {}) => {
  try {
    const { stdout } = await executeFile('docker', [...arguments_], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 512 * 1024,
      env: { PATH: process.env.PATH, HOME: homedir(), ...additions },
    });
    return stdout.trim();
  } catch {
    throw new RehearsalSafetyError('OWNED_DOCKER_COMMAND_FAILED');
  }
};

function object(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new RehearsalSafetyError('DOCKER_METADATA_REFUSED');
  return candidate as Record<string, unknown>;
}
function text(candidate: unknown): string {
  if (typeof candidate !== 'string') throw new RehearsalSafetyError('DOCKER_METADATA_REFUSED');
  return candidate;
}
function oneRecord(serialized: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new RehearsalSafetyError('DOCKER_METADATA_REFUSED');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new RehearsalSafetyError('DOCKER_METADATA_REFUSED');
  return object(parsed[0]);
}
function jsonString(serialized: string): string {
  try {
    return text(JSON.parse(serialized));
  } catch {
    throw new RehearsalSafetyError('DOCKER_METADATA_REFUSED');
  }
}

/** Context inspection is local-file metadata; no daemon call occurs until its Unix endpoint is accepted. */
export async function localDockerIdentity(
  docker: DockerCommand = executeDocker,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LocalDockerIdentity> {
  if (
    environment.DOCKER_HOST ||
    environment.DOCKER_CONFIG ||
    environment.DOCKER_TLS_VERIFY ||
    environment.DOCKER_CERT_PATH
  )
    throw new RehearsalSafetyError('LOCAL_DOCKER_REQUIRED');
  const context = environment.DOCKER_CONTEXT ?? (await docker(['context', 'show']));
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(context)) throw new RehearsalSafetyError('LOCAL_DOCKER_REQUIRED');
  const metadata = oneRecord(await docker(['context', 'inspect', context]));
  const endpoint = text(object(object(metadata.Endpoints).docker).Host);
  // Use a provisional non-sensitive ID only to validate the endpoint before info.
  assertLocalDockerIdentity({ context, endpoint, daemonId: 'pending-local-id' });
  const daemonId = jsonString(await docker(['--host', endpoint, 'info', '--format', '{{json .ID}}']));
  const identity = { context, endpoint, daemonId };
  assertLocalDockerIdentity(identity);
  return Object.freeze(identity);
}

/** Every later call pins the inspected Unix socket, never a mutable context alias. */
export function pinnedDocker(identity: LocalDockerIdentity, docker: DockerCommand = executeDocker): DockerCommand {
  assertLocalDockerIdentity(identity);
  return (arguments_, additions) => docker(['--host', identity.endpoint, ...arguments_], additions);
}

export async function inspectOwnedContainer(
  expected: ExpectedOwnedContainer,
  docker: DockerCommand = executeDocker,
): Promise<{ endpoint: OwnedLocalEndpoint; proof: OwnedContainerProof }> {
  const pinned = pinnedDocker(expected.identity, docker);
  const daemonId = jsonString(await pinned(['info', '--format', '{{json .ID}}']));
  const currentIdentity = { ...expected.identity, daemonId };
  const container = oneRecord(await pinned(['inspect', '--type', 'container', expected.containerId]));
  const network = oneRecord(await pinned(['network', 'inspect', expected.networkId]));
  const configuration = object(container.Config);
  const networkSettings = object(container.NetworkSettings);
  const networks = object(networkSettings.Networks);
  const networkRecords = Object.values(networks).map(object);
  const servicePort = expected.service === 'postgres' ? '5432/tcp' : '6379/tcp';
  const ports = object(networkSettings.Ports);
  const publishedPorts = Object.entries(ports).filter(([, bindings]) => bindings !== null);
  if (publishedPorts.length !== 1 || publishedPorts[0][0] !== servicePort)
    throw new RehearsalSafetyError('OWNED_LOOPBACK_BINDING_REQUIRED');
  const bindings = ports[servicePort];
  if (!Array.isArray(bindings)) throw new RehearsalSafetyError('OWNED_LOOPBACK_BINDING_REQUIRED');
  const binding = bindings.length === 1 ? object(bindings[0]) : {};
  const labels = object(configuration.Labels);
  const networkLabels = object(network.Labels);
  if (networkLabels[REHEARSAL_CONTAINER_LABEL] !== expected.runNonce || network.Id !== expected.networkId)
    throw new RehearsalSafetyError('OWNED_INTERNAL_NETWORK_REQUIRED');
  const mounts = container.Mounts;
  if (!Array.isArray(mounts)) throw new RehearsalSafetyError('DOCKER_METADATA_REFUSED');
  const proof: OwnedContainerProof = {
    containerId: text(container.Id),
    imageId: text(container.Image),
    containerName: text(container.Name),
    runLabel: typeof labels[REHEARSAL_CONTAINER_LABEL] === 'string' ? labels[REHEARSAL_CONTAINER_LABEL] : undefined,
    running: object(container.State).Running === true,
    networkId: networkRecords.length === 1 ? text(networkRecords[0].NetworkID) : '',
    internalNetwork: network.Internal === true,
    networkCount: networkRecords.length,
    hostIp: typeof binding.HostIp === 'string' ? binding.HostIp : '',
    hostPort: typeof binding.HostPort === 'string' ? binding.HostPort : '',
    bindingCount: bindings.length,
    hasHostBindMount: mounts.some((mount) => object(mount).Type === 'bind'),
  };
  return { endpoint: ownedLocalEndpoint(currentIdentity, proof, expected), proof };
}
