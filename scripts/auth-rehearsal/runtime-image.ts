import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localDockerIdentity, type DockerCommand, executeDocker } from './docker';
import { RehearsalSafetyError, type LocalDockerIdentity } from './target-guard';

export interface RuntimeImage {
  readonly imageId: string;
  readonly identity: LocalDockerIdentity;
}
const builtImages = new WeakSet<object>();
const contextModuleUrl = new URL('./runtime-context.mjs', import.meta.url).href;

/** No caller-selected image or context: source is allowlisted and Linux dependencies are frozen. */
export async function buildRuntimeImage(docker: DockerCommand = executeDocker): Promise<RuntimeImage> {
  const identity = await localDockerIdentity(docker);
  const contextModule = (await import(contextModuleUrl)) as { createRuntimeContext: () => { directory: string } };
  const context = contextModule.createRuntimeContext();
  const configuration = await mkdtemp(join(tmpdir(), 'boardsesh-public-rehearsal-build-'));
  try {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['--config', configuration, '--host', identity.endpoint, 'build', '--quiet', context.directory],
      { env: { PATH: process.env.PATH, HOME: homedir() }, timeout: 1200000, maxBuffer: 1024 * 1024 },
    );
    const imageId = stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new RehearsalSafetyError('OWNED_RUNTIME_IMAGE_REQUIRED');
    const receipt = Object.freeze({ imageId, identity });
    builtImages.add(receipt);
    return receipt;
  } catch {
    throw new RehearsalSafetyError('OWNED_RUNTIME_BUILD_FAILED');
  } finally {
    await rm(configuration, { recursive: true });
    await rm(context.directory, { recursive: true });
  }
}
export function requireBuiltRuntimeImage(image: RuntimeImage): void {
  if (!builtImages.has(image)) throw new RehearsalSafetyError('OWNED_RUNTIME_BUILD_RECEIPT_REQUIRED');
}
