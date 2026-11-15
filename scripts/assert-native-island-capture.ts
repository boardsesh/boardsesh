import { readFileSync } from 'node:fs';
import { extractScreenshotIsland } from './lib/screenshot-island';

// Validate the expanded system surface, not merely a nonempty phone screenshot.
const file = process.argv[2];
if (!file) throw new Error('Expected the native screenshot filename');
await extractScreenshotIsland(readFileSync(file));
