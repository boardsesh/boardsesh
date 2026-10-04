/**
 * Renders every `*.excalidraw` scene in a directory to a sibling `.svg` and
 * `.png` (2x scale, white background), using Excalidraw's own exporters in a
 * headless Chromium page.
 *
 * The `.excalidraw` files are the editable source of truth: open one at
 * https://excalidraw.com (File > Open), edit, save it back over the original,
 * then re-run this script so the committed SVG/PNG match the scene.
 *
 * How it works:
 *   - Playwright is taken from the web package's `@playwright/test` (already a
 *     workspace dependency, nothing new is installed into the repo).
 *   - The page imports `@excalidraw/excalidraw` at the pinned version below
 *     from esm.sh, so the renderer needs network access to esm.sh the first
 *     time it runs; the browser caches it for the rest of the run.
 *   - `exportToSvg` produces the SVG, `exportToBlob` the PNG.
 *
 * One-time setup (downloads a headless Chromium into ~/.cache/ms-playwright):
 *   cd packages/web && vp exec playwright install chromium-headless-shell
 *
 * Usage:
 *   vp exec node scripts/render-excalidraw.mjs docs/diagrams/rust-backend
 *   vp exec node scripts/render-excalidraw.mjs docs/diagrams/rust-backend 03-ws-connection-lifecycle
 *
 * The optional second argument renders only scenes whose file name starts with
 * it.
 */
import { createRequire } from 'node:module';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCALIDRAW_VERSION = '0.18.0';
const EXCALIDRAW_MODULE_URL = `https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}?bundle-deps`;
const PNG_SCALE = 2;
const EXPORT_PADDING = 24;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is resolved from packages/web on purpose: it is the one workspace
// package that already depends on @playwright/test (for the e2e suite), and the
// root package.json deliberately carries no dev tooling of its own. If the e2e
// suite ever moves, point this at the package that owns Playwright then.
const PLAYWRIGHT_OWNER_MANIFEST = join(repoRoot, 'packages/web/package.json');
let chromium;
try {
  ({ chromium } = createRequire(PLAYWRIGHT_OWNER_MANIFEST)('@playwright/test'));
} catch (error) {
  console.error(
    `could not resolve @playwright/test from ${PLAYWRIGHT_OWNER_MANIFEST}: ${error instanceof Error ? error.message : String(error)}\n` +
      'Run `vp install`; if the e2e suite moved out of packages/web, update PLAYWRIGHT_OWNER_MANIFEST.',
  );
  process.exit(1);
}

const [targetDirArg, namePrefix = ''] = process.argv.slice(2);
if (!targetDirArg) {
  console.error('usage: vp exec node scripts/render-excalidraw.mjs <dir> [name-prefix]');
  process.exit(2);
}
const targetDir = resolve(process.cwd(), targetDirArg);

const sceneFiles = (await readdir(targetDir))
  .filter((fileName) => fileName.endsWith('.excalidraw') && fileName.startsWith(namePrefix))
  .sort();
if (sceneFiles.length === 0) {
  console.error(`no .excalidraw files in ${targetDir}`);
  process.exit(1);
}

// Served from a fake http origin so the module import and font fetches behave
// as they would on a normal page (about:blank has an opaque origin).
const PAGE_URL = 'http://excalidraw-render.local/';
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  window.EXCALIDRAW_ASSET_PATH = 'https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/prod/';
  import(${JSON.stringify(EXCALIDRAW_MODULE_URL)})
    .then((lib) => { window.__excalidraw = lib; window.__ready = true; })
    .catch((error) => { window.__loadError = String(error && error.stack || error); });
</script></body></html>`;

// The exporter is loaded from esm.sh at run time rather than installed as a
// workspace dependency: this script is run by hand when a diagram changes, never
// in CI, and @excalidraw/excalidraw drags React and a large asset tree into the
// lockfile that nothing else in the repo needs. The trade-off is a network
// dependency, so check it up front and fail with a clear message instead of
// letting the page import hang.
const CDN_PREFLIGHT_TIMEOUT_MS = 10_000;
const CDN_IMPORT_TIMEOUT_MS = 60_000;
try {
  const response = await fetch(EXCALIDRAW_MODULE_URL, {
    method: 'HEAD',
    signal: AbortSignal.timeout(CDN_PREFLIGHT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(
    `cannot reach ${EXCALIDRAW_MODULE_URL} (${error instanceof Error ? error.message : String(error)}).\n` +
      'The renderer needs outbound access to esm.sh; it is a manual, dev-only step and is not run in CI.',
  );
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[page]', error.message));
  await page.route(PAGE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }));
  await page.goto(PAGE_URL);
  try {
    await page.waitForFunction(() => window.__ready || window.__loadError, null, { timeout: CDN_IMPORT_TIMEOUT_MS });
  } catch {
    throw new Error(`Excalidraw did not finish loading from esm.sh within ${CDN_IMPORT_TIMEOUT_MS / 1000}s`);
  }
  const loadError = await page.evaluate(() => window.__loadError);
  if (loadError) throw new Error(`could not load Excalidraw from esm.sh: ${loadError}`);

  for (const sceneFile of sceneFiles) {
    const baseName = sceneFile.replace(/\.excalidraw$/, '');
    const scene = JSON.parse(await readFile(join(targetDir, sceneFile), 'utf8'));
    try {
      const { svg, pngBase64 } = await page.evaluate(
        async ({ scene, pngScale, padding }) => {
          const { exportToSvg, exportToBlob } = window.__excalidraw;
          const appState = {
            ...scene.appState,
            exportBackground: true,
            viewBackgroundColor: '#ffffff',
            exportWithDarkMode: false,
            exportEmbedScene: false,
          };
          const files = scene.files || {};
          const svgElement = await exportToSvg({ elements: scene.elements, appState, files, exportPadding: padding });
          const blob = await exportToBlob({
            elements: scene.elements,
            appState,
            files,
            exportPadding: padding,
            mimeType: 'image/png',
            getDimensions: (width, height) => ({ width: width * pngScale, height: height * pngScale, scale: pngScale }),
          });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return { svg: svgElement.outerHTML, pngBase64: btoa(binary) };
        },
        { scene, pngScale: PNG_SCALE, padding: EXPORT_PADDING },
      );
      await writeFile(join(targetDir, `${baseName}.svg`), `${svg}\n`);
      await writeFile(join(targetDir, `${baseName}.png`), Buffer.from(pngBase64, 'base64'));
      console.log(`rendered ${baseName} (.svg ${svg.length} B, .png ${Math.round((pngBase64.length * 3) / 4)} B)`);
    } catch (error) {
      failures += 1;
      console.error(`failed ${baseName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
