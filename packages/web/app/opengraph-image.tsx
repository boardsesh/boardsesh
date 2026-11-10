import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtime = 'nodejs';

export const alt = 'Boardsesh: one app for your boards';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/jpeg';

// Rendered once through the backend's real card pipeline and committed:
// packages/backend/src/scripts/render-default-share-card.ts regenerates it.
// Resolved via import.meta.url so @vercel/nft traces it into the standalone
// container build. dirname+join yields a plain string, which avoids a Turbopack
// URL-prototype mismatch we saw when passing the URL straight into readFileSync.
const cardPath = join(dirname(fileURLToPath(import.meta.url)), 'default-share-card.jpg');
const cardJpeg = new Uint8Array(readFileSync(cardPath));

export default function Image() {
  return new Response(cardJpeg, { headers: { 'Content-Type': contentType } });
}
