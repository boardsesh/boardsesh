// Reports the eager JS payload of an Expo web export and verifies that its
// eager scripts and referenced async chunks exist.
//
// "Eager" means every <script src> the exported index.html carries — NOT just
// entry-*.js. Once route splitting is on, Metro hoists everything shared into a
// __common chunk that the shell loads alongside the entry, so an entry-only
// measurement would read ~230 KB while the browser actually fetches ~1.9 MB. The
// number that matters to a reader on mobile data is the sum.
import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [outputDir, baseUrlRaw = ''] = process.argv.slice(2);
if (!outputDir) {
  console.error('Usage: node inspect-expo-web-export.mjs <output-dir> [base-url]');
  process.exit(1);
}

// The shell's hrefs are prefixed with the export's baseUrl ('' for the
// app.boardsesh.com root export, '/app' for the dev-proxy one), but the files
// sit at the output root either way. Strip it, or the /app mode looks for
// <out>/app/_expo/... and every file "does not exist".
const baseUrl = baseUrlRaw.replace(/\/+$/, '');
const toFile = (href) => {
  const withoutBase = baseUrl && href.startsWith(`${baseUrl}/`) ? href.slice(baseUrl.length) : href;
  return path.join(outputDir, withoutBase.replace(/^\/+/, ''));
};
const shellPath = path.join(outputDir, 'index.html');
const shell = readFileSync(shellPath, 'utf8');

const eager = [...shell.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
if (eager.length === 0) {
  console.error(`[web-export] no <script src> found in ${shellPath} — the export is broken`);
  process.exit(1);
}

let raw = 0;
let brotli = 0;
const rows = [];
for (const href of eager) {
  const file = toFile(href);
  if (!existsSync(file)) {
    console.error(`[web-export] index.html references ${href}, which does not exist on disk`);
    process.exit(1);
  }
  const bytes = readFileSync(file);
  const br = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  }).length;
  raw += bytes.length;
  brotli += br;
  rows.push(`    ${path.basename(file)}  raw=${bytes.length.toLocaleString()}  br=${br.toLocaleString()}`);
}

// Keep per-file and total sizes visible in CI without gating contributions on
// a repository variable that fork workflows cannot read.
console.log(`[web-export] eager JS: ${eager.length} file(s)`);
for (const row of rows) console.log(row);
console.log(`[web-export] total raw=${raw.toLocaleString()} brotli=${brotli.toLocaleString()}`);

// Every async chunk the bundles ask for must exist. Splitting makes this
// reachable for the first time: a chunk path that does not resolve is answered
// by Cloudflare Pages' `/* /index.html 200` catch-all with the HTML shell, which
// the browser then tries to evaluate as JavaScript. `functions/_middleware.ts`
// contains that AFTER deploy; this catches it before.
const referenced = new Set();
for (const href of eager) {
  const file = toFile(href);
  for (const match of readFileSync(file, 'utf8').matchAll(
    new RegExp(`["'\`]((?:${baseUrl})?/_expo/static/js/web/[A-Za-z0-9._-]+\\.js)["'\`]`, 'g'),
  )) {
    referenced.add(match[1]);
  }
}
const dangling = [...referenced].filter((href) => !existsSync(toFile(href)));
if (dangling.length > 0) {
  console.error('[web-export] bundles reference chunk(s) that do not exist on disk:');
  for (const href of dangling) console.error(`  - ${href}`);
  process.exit(1);
}
console.log(`[web-export] ${referenced.size} referenced async chunk path(s) all resolve`);
