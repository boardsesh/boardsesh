import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDockerIdentity, pinnedDocker } from './docker';
import { REHEARSAL_POSTGRES_IMAGE, RehearsalSafetyError } from './target-guard';
import { REHEARSAL_REDIS_IMAGE } from './owned-target';

/** Public immutable image preparation only: no fixture containers, URLs or operator registry credentials. */
async function main() {
  if (process.argv.length !== 2) throw new RehearsalSafetyError('IMAGE_PREPARATION_ARGUMENTS_REFUSED');
  const identity = await localDockerIdentity();
  const docker = pinnedDocker(identity);
  const configuration = await mkdtemp(join(tmpdir(), 'boardsesh-public-rehearsal-images-'));
  try {
    for (const image of [REHEARSAL_POSTGRES_IMAGE, REHEARSAL_REDIS_IMAGE]) {
      await docker(['--config', configuration, 'pull', image]);
    }
  } finally {
    await rm(configuration, { recursive: true });
  }
  console.log('PINNED_FIXTURE_IMAGES_READY');
}
void main().catch((error: unknown) => {
  console.error(error instanceof RehearsalSafetyError ? error.code : 'IMAGE_PREPARATION_FAILED');
  process.exitCode = 1;
});
