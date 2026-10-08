import { ensureScreenshotFixtures, installFixtureSnapshotReference } from './lib/screenshot-fixture-snapshot';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.length && (args.length !== 2 || args[0] !== '--reference-url')) {
    throw new Error('Usage: vp run mobile:screenshot-fixtures-fetch -- [--reference-url public-https-json-url]');
  }
  const directory = args.length ? await installFixtureSnapshotReference(args[1]) : await ensureScreenshotFixtures();
  console.log(`[screenshot-fixtures] Verified ${directory}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Screenshot fixture download failed');
  process.exitCode = 1;
});
