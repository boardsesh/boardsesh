import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `vercel.json` is strict JSON, so the reasoning behind the one `functions`
 * override in this repo has nowhere to live next to the value. It lives here.
 *
 * ## Why 1769
 *
 * Vercel inherits Lambda's allocation model, where memory buys CPU on a fixed
 * curve and **1769 MB is the one-vCPU point**. That is the number that matters
 * for this route, because the expensive half is single-threaded:
 * `sharp-runtime.ts` pins `sharp.concurrency(1)`, and a production
 * `Server-Timing` reads `sharp;dur=393.7, compose;dur=393.7` — the composite is
 * the whole cost, on one thread. Memory beyond the one-vCPU point buys
 * parallelism this route does not use for a single render.
 *
 * ## Why not lower
 *
 * Provisioned memory bills as **memory × wall time**, so halving the size and
 * doubling the duration saves nothing and ships a slower LCP image:
 *
 *     2.94 GB × 0.45 s = 1.32 GB-s
 *     1.00 GB × 1.35 s = 1.35 GB-s
 *
 * Below the one-vCPU point the composite loses a full core and that trade turns
 * bad. Anything lower needs a measured `sharp;dur` before and after, not a
 * guess.
 *
 * ## Why it was 3009
 *
 * It was a stopgap, not a sizing decision. `/api/internal/board-render` was
 * OOM-killed 507 times in three days on the 1 GB default — 61% of all error
 * volume — and 3009 was raised to stop the bleeding while the actual fixes
 * landed (see the commit: "this is the stopgap that stops the instance dying
 * while they land"). Those fixes landed two days later in #4675 and measured
 * peak RSS at ~362 MB at 2-way concurrency, down from 733 MB. Nobody lowered
 * the stopgap.
 *
 * Every allocation is bounded now, which is why ~400 MB is the real figure:
 * `board-render-cache.ts` caps its three LRUs at 64 + 32 + 32 MB, libvips runs
 * a 16 MB / 100-item cache, `MAX_RENDER_OUTPUT_PIXELS` caps one output buffer
 * at 3 MP (12 MB RGBA), and the route's semaphore allows two renders at once.
 *
 * 1769 leaves ~4.9× headroom over the measured peak.
 *
 * If you are changing this: measure, then update this comment with what you
 * measured. A number nobody can justify is how we got 3009.
 */

const BOARD_RENDER_ROUTE = 'app/api/internal/board-render/route.ts';

/** Lambda's one-vCPU allocation point, which Vercel inherits. */
const ONE_VCPU_MB = 1769;

/** Peak RSS measured at 2-way concurrency after #4675. */
const MEASURED_PEAK_MB = 362;

type VercelConfig = {
  functions?: Record<string, { memory?: number; maxDuration?: number }>;
};

// Resolved from this file, not cwd — the vitest project's working directory is
// not packages/web. Same approach as rest-surface-inventory.test.ts.
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vercelConfig = JSON.parse(readFileSync(join(WEB_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

describe('board-render function config', () => {
  const fn = vercelConfig.functions?.[BOARD_RENDER_ROUTE];

  it('is still bound to the route (the path is relative to the Vercel Root Directory)', () => {
    // Root Directory is `packages/web`, so this path resolves from here — not
    // from the repo root. A path that matches nothing means the override is
    // silently absent and the route runs on the 1 GB default, which is the
    // configuration that OOM-killed it 507 times.
    expect(fn, `no functions entry for ${BOARD_RENDER_ROUTE}`).toBeDefined();
    expect(Object.keys(vercelConfig.functions ?? {})).toEqual([BOARD_RENDER_ROUTE]);
  });

  it('sits at the one-vCPU point, because the composite is single-threaded', () => {
    expect(fn?.memory).toBe(ONE_VCPU_MB);
  });

  it('keeps real headroom over the measured peak without paying for unused vCPU', () => {
    const memory = fn?.memory ?? 0;
    // Lower bound: never go back under the measured peak with no margin.
    expect(memory).toBeGreaterThan(MEASURED_PEAK_MB * 2);
    // Upper bound: 3009 was a stopgap. Raising it again should be a deliberate
    // act that updates the doc comment above, not a quiet re-panic.
    expect(memory).toBeLessThan(2048);
  });

  it('keeps the 30s ceiling so a pathological render fails fast instead of holding the slot', () => {
    expect(fn?.maxDuration).toBe(30);
  });
});
