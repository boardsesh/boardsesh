import { runBetaLinkRevalidationBatch } from '@/app/lib/beta-link-revalidation';

declare global {
  // eslint-disable-next-line no-var
  var __boardseshLocalBetaLinkCronStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __boardseshLocalBetaLinkCronTimeout: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __boardseshLocalBetaLinkCronInterval: NodeJS.Timeout | undefined;
}

const RUN_MINUTES = [0, 15, 30, 45];
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function getDelayUntilNextRun(now = new Date()): number {
  for (const minute of RUN_MINUTES) {
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(minute);

    if (next > now) {
      return next.getTime() - now.getTime();
    }
  }

  const nextHour = new Date(now);
  nextHour.setHours(nextHour.getHours() + 1, RUN_MINUTES[0], 0, 0);
  return nextHour.getTime() - now.getTime();
}

async function runLocalBetaLinkCron(): Promise<void> {
  try {
    const result = await runBetaLinkRevalidationBatch({
      batchSize: 250,
      concurrency: 6,
      deadlineMs: 45_000,
    });

    if (result.processed > 0) {
      console.log(
        `[Local beta link cron] Processed ${result.processed} links (${result.madeAccessible} accessible, ${result.madeInaccessible} inaccessible). ${result.remainingEligible} remaining.`,
      );
    }
  } catch (error) {
    console.error('[Local beta link cron] Error:', error);
  }
}

export function startLocalBetaLinkCron(): void {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  if (globalThis.__boardseshLocalBetaLinkCronStarted) {
    return;
  }

  globalThis.__boardseshLocalBetaLinkCronStarted = true;

  const initialDelay = getDelayUntilNextRun();
  const nextRunAt = new Date(Date.now() + initialDelay);
  console.log(`[Local beta link cron] Scheduled first run at ${nextRunAt.toISOString()}`);

  globalThis.__boardseshLocalBetaLinkCronTimeout = setTimeout(() => {
    void runLocalBetaLinkCron();
    globalThis.__boardseshLocalBetaLinkCronInterval = setInterval(() => {
      void runLocalBetaLinkCron();
    }, FIFTEEN_MINUTES_MS);
  }, initialDelay);
}
