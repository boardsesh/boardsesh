import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDevObjectPublisher } from './lib/dev-object-store';
import { createFixtureSnapshotArchive } from './lib/screenshot-fixture-archive';
import { FIXTURE_SNAPSHOT_REFERENCE } from './lib/screenshot-fixture-snapshot';
import { DEFAULT_SCREENSHOT_FIXTURES_DIR } from './lib/screenshot-fixtures';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const archiveIndex = args.indexOf('--archive');
  let archivePath: string | undefined;
  if (archiveIndex !== -1) {
    archivePath = args[archiveIndex + 1];
    if (!archivePath || archivePath.startsWith('--')) throw new Error('--archive requires an output path');
    args.splice(archiveIndex, 2);
  }
  if (args.length > 1 || args.some((argument) => argument.startsWith('--'))) {
    throw new Error(
      'Usage: vp run mobile:screenshot-fixtures-publish -- [--archive output.json.gz] [recording-directory]',
    );
  }
  const directory = resolve(args[0] ?? DEFAULT_SCREENSHOT_FIXTURES_DIR);
  const { compressed, reference, graphqlCount } = createFixtureSnapshotArchive(directory);
  if (archivePath) {
    // Offline export uses exactly the publisher's sanitizer and archive checks.
    // It never loads credentials, uploads bytes, or changes the committed pin.
    writeFileSync(resolve(archivePath), compressed, { flag: 'wx' });
    console.log(JSON.stringify({ sha256: reference.sha256, bytes: reference.bytes, files: reference.files }));
    return;
  }
  const publish = createDevObjectPublisher();
  const key = `screenshot-fixtures/${reference.sha256}.json.gz`;
  reference.url = await publish(key, compressed, 'application/gzip');
  writeFileSync(FIXTURE_SNAPSHOT_REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`[screenshot-fixtures] Published ${graphqlCount} GraphQL fixtures: ${reference.url}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Fixture snapshot publishing failed');
  process.exitCode = 1;
});
