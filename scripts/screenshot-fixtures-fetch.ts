import { ensureScreenshotFixtures } from './lib/screenshot-fixture-snapshot';

ensureScreenshotFixtures().then(
  (directory) => console.log(`[screenshot-fixtures] Verified ${directory}`),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Screenshot fixture download failed');
    process.exitCode = 1;
  },
);
