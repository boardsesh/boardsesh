import { once } from 'node:events';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * Serves the standalone Expo web export the way app.boardsesh.com does: files
 * from the export root, and every other path answered with `index.html` so a
 * deep route reloads into the SPA (production does this with its host's
 * `/* /index.html 200` rule).
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export async function startStaticServer(exportDirectory: string): Promise<{ port: number; server: Server }> {
  const root = resolve(exportDirectory);
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`No Expo web export at ${root} (no index.html). Run \`vp run test:e2e:browser-session\`.`);
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const candidate = normalize(join(root, pathname));
    // Never leave the export root, whatever the path says.
    const insideRoot = candidate === root || candidate.startsWith(root + sep);
    const isFile = insideRoot && existsSync(candidate) && statSync(candidate).isFile();
    const served = isFile ? candidate : join(root, 'index.html');
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(served)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(served).pipe(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, server };
}
