import { ensureScreenshotFixtures } from '../../../scripts/lib/screenshot-fixture-snapshot';

export default async function setup(): Promise<void> {
  await ensureScreenshotFixtures();
}
