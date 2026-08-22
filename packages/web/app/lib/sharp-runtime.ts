import sharp from 'sharp';

let configured = false;

/**
 * Tune libvips for a serverless function instance.
 *
 * The defaults assume a long-lived server with the machine to itself: libvips
 * sizes its operation cache at 50 MB / 20 000 items and runs one worker thread
 * per core. Inside a Vercel function that is memory we don't have and
 * parallelism we can't use — several concurrent renders each spawn a full
 * thread pool over multi-megapixel board photos, and the instance gets
 * OOM-killed rather than slowed down (507 kills in three days on
 * `/api/internal/board-render`).
 *
 * A 16 MB / 100-item cache still absorbs the repeat board-photo reads, and one
 * thread per operation keeps peak RSS proportional to the render concurrency
 * limit instead of to core count. Route-level only — the long-running backend
 * renderer keeps libvips' defaults.
 *
 * Idempotent: safe to call from any module's top level.
 */
export function configureSharpForServerless(): void {
  if (configured) return;
  configured = true;
  sharp.cache({ memory: 16, files: 4, items: 100 });
  sharp.concurrency(1);
}
