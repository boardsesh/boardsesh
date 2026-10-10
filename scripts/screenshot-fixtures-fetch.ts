import { resolve } from 'node:path';
import {
  ensureScreenshotFixtures,
  FIXTURE_SNAPSHOT_REFERENCE,
  installFixtureSnapshotReference,
  readFixtureSnapshotReference,
} from './lib/screenshot-fixture-snapshot';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (!['--reference', '--reference-url'].includes(flag) || !argument || argument.startsWith('--') || flags.has(flag))
      throw new Error(
        'Usage: vp run mobile:screenshot-fixtures-fetch -- [--reference local-pin.json] [--reference-url public-https-json-url]',
      );
    flags.set(flag, argument);
  }
  const reference = flags.has('--reference') ? resolve(flags.get('--reference')!) : FIXTURE_SNAPSHOT_REFERENCE;
  const candidate = flags.get('--reference-url');
  const directory = candidate
    ? await installFixtureSnapshotReference(candidate, reference)
    : await ensureScreenshotFixtures(readFixtureSnapshotReference(reference));
  console.log(`[screenshot-fixtures] Verified ${directory}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Screenshot fixture download failed');
  process.exitCode = 1;
});
