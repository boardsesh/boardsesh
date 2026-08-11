import crypto from 'crypto';
import { NextResponse } from 'next/server';

/**
 * Shared auth guard for the handful of `/api/internal/*` routes that Vercel
 * invokes on a schedule (see `packages/web/vercel.json`'s `crons` array).
 *
 * The env var MUST be named `CRON_SECRET` — Vercel auto-injects
 * `Authorization: Bearer <CRON_SECRET>` on every cron invocation only when
 * the project env var has this exact name
 * (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
 * Renaming it (e.g. to `CRON_TOKEN`) would silently break that auto-injection
 * and 401 every cron run.
 *
 * There is a second caller now: the Railway scheduler (`packages/scheduler`)
 * sends the identical `Authorization: Bearer $CRON_SECRET` header for the jobs
 * that have moved off Vercel. It reads the same secret from its own env, so
 * the name stays `CRON_SECRET` on both sides — rotating it means updating the
 * Vercel project env AND the Railway service env together, or one of the two
 * schedulers starts 401ing. `docs/scheduler.md` tracks which job runs where.
 *
 * Comparison is constant-time to avoid leaking the secret's value through
 * response-timing side channels, mirroring the pattern used for the native
 * OAuth transfer token in `native-oauth-transfer.ts`.
 */
export function requireCronAuth(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret || !authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const actual = Buffer.from(authHeader);

  if (expected.length !== actual.length) {
    // No-op timingSafeEqual so this branch takes the same time as the
    // valid-length comparison below — the length itself isn't secret, but
    // this keeps the two branches trivially indistinguishable.
    crypto.timingSafeEqual(expected, expected);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!crypto.timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
