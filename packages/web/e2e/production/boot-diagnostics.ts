// Diagnostics for the production boot smoke (./boot.spec.ts).
//
// Split out of the spec rather than left inline so it can be exercised on its
// own: importing a spec file from another spec re-registers its tests, so there
// is no way to prove this code reports what it should while it lives there.
import { expect, type Page } from '@playwright/test';

/**
 * Errors that mean the app is broken rather than noisy. Kept narrow on purpose:
 * a production smoke that fails on any console error becomes a flake generator
 * (third-party scripts, extensions, aborted requests on unload) and then gets
 * ignored, which is worse than not having it.
 */
const FATAL_CONSOLE_PATTERNS = [
  /Unable to get view config/i,
  /No QueryClient set/i,
  /Maximum update depth exceeded/i,
  /ChunkLoadError/i,
  /Failed to fetch dynamically imported module/i,
];

/**
 * Everything worth printing when the app fails to mount. `fatal` is the narrow
 * set the spec asserts on; the rest is context that is only printed once
 * something has already gone wrong, so it costs nothing on a green run.
 */
export type BootDiagnostics = {
  fatal: string[];
  /** Scripts that failed outright, or came back as something other than JS. */
  scriptProblems: string[];
  consoleErrors: string[];
};

export function collectDiagnostics(page: Page): BootDiagnostics {
  const diagnostics: BootDiagnostics = { fatal: [], scriptProblems: [], consoleErrors: [] };

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Capped: a broken boot can log the same error on a loop, and a thousand
    // identical lines buries the one that matters.
    if (diagnostics.consoleErrors.length < 20) diagnostics.consoleErrors.push(text);
    if (FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) diagnostics.fatal.push(text);
  });

  // An uncaught exception is always fatal — that is a bundle that failed to boot.
  page.on('pageerror', (error) => diagnostics.fatal.push(`pageerror: ${String(error)}`));

  // The failure this exists for: `_redirects` answers a missing chunk with
  // `/index.html 200` and `_headers` stamps `immutable` on it by path, so a
  // script URL can come back as the HTML shell looking entirely healthy. Chrome
  // then refuses to execute it (`nosniff`), React never mounts, and #root stays
  // empty — with no page error and no console text matching the patterns above.
  // Without this listener that failure is indistinguishable from "nothing
  // happened", which is how it once failed a deploy with nothing to go on.
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    const contentType = response.headers()['content-type'] ?? '(none)';
    if (/javascript|ecmascript/i.test(contentType)) return;
    diagnostics.scriptProblems.push(`${response.url()} → HTTP ${response.status()}, content-type: ${contentType}`);
  });

  page.on('requestfailed', (request) => {
    if (request.resourceType() !== 'script') return;
    diagnostics.scriptProblems.push(`${request.url()} → request failed: ${request.failure()?.errorText ?? 'unknown'}`);
  });

  return diagnostics;
}

export function formatDiagnostics(diagnostics: BootDiagnostics): string {
  const sections = [
    ['script problems', diagnostics.scriptProblems],
    ['page/fatal errors', diagnostics.fatal],
    ['console errors', diagnostics.consoleErrors],
  ] as const;
  return sections
    .map(([label, lines]) => `${label}:\n${lines.length ? lines.map((line) => `  ${line}`).join('\n') : '  (none)'}`)
    .join('\n');
}

/**
 * Assert React committed something into #root, and — when it did not — fail with
 * what the page actually did rather than a bare "element(s) not found".
 *
 * The diagnostics have to be attached here rather than asserted at the end of
 * the spec: this is the assertion that trips first, so anything checked after it
 * never runs on the one failure that needs explaining.
 */
export async function expectMounted(page: Page, timeout: number, diagnostics: BootDiagnostics) {
  const root = page.locator('#root');
  try {
    // `#boot-paint` is the static loading state the HTML shell ships INSIDE
    // #root (packages/mobile/public/index.html). React's createRoot clears the
    // container on first commit, so its disappearance is the mount signal.
    //
    // This has to come first. The old check was "#root has any child", which
    // was proof of mount only while the shell shipped #root empty — once it
    // carries a boot paint, that assertion passes against markup the server
    // sent, before a line of JS has run, and the whole smoke silently stops
    // testing anything. Waiting for the placeholder to GO is strictly stronger:
    // it proves React not only mounted but replaced what was there.
    await expect(page.locator('#boot-paint')).toBeHidden({ timeout });
    await expect(root.locator('> *').first()).toBeAttached({ timeout });
  } catch (cause) {
    throw new Error(
      `#root still shows the boot paint — the bundle did not mount.\n\n${formatDiagnostics(diagnostics)}\n\n${String(cause)}`,
    );
  }
}
