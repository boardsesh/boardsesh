#!/usr/bin/env node
import { loadSchedulerConfig, SchedulerConfigError } from '../config';
import { createMinuteTicker } from '../cron/scheduler';
import { createHealthServer } from '../health-server';
import { JOBS } from '../jobs/registry';
import { consoleLogger, describeError } from '../logger';
import { createScheduler } from '../runner';

const USAGE = `Boardsesh scheduler

Usage:
  scheduler start           Run the cron scheduler and health server (long-lived)
  scheduler run <job>       Run one job immediately and exit
  scheduler list            List known jobs and their schedules

Environment:
  CRON_SECRET               Required. Same value as the Vercel project env var.
  BOARDSESH_WEB_URL         Web app base URL (default https://www.boardsesh.com)
  PORT                      Health server port (default 8080)
  SCHEDULER_DISABLED_JOBS   Comma-separated job names to leave unscheduled
`;

function printUsage(): void {
  process.stdout.write(USAGE);
}

async function runStart(): Promise<void> {
  const config = loadSchedulerConfig();
  const cron = createMinuteTicker({
    onHandlerError: (error, expression) =>
      consoleLogger.error('cron handler threw', { expression, error: describeError(error) }),
  });
  const scheduler = createScheduler({ jobs: JOBS, config, cron, logger: consoleLogger });
  const healthServer = createHealthServer({
    port: config.port,
    getStatus: () => scheduler.getStatus(),
    logger: consoleLogger,
  });

  await healthServer.start();
  consoleLogger.info('scheduler started', {
    webBaseUrl: config.webBaseUrl,
    scheduledJobs: scheduler.scheduledJobs.map((job) => job.name),
  });

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    consoleLogger.info('shutting down', { signal });
    scheduler.stop();
    cron.stop();
    void healthServer.stop().then(() => process.exit(0));
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

async function runOneJob(jobName: string | undefined): Promise<void> {
  if (!jobName) {
    process.stderr.write('scheduler run: a job name is required\n');
    printUsage();
    process.exit(1);
  }

  const config = loadSchedulerConfig();
  // A one-shot run needs no ticker. `registerSchedules: false` keeps `run`
  // from also starting the recurring schedule, and keeps a job held back by
  // SCHEDULER_DISABLED_JOBS runnable on demand — the env flag only silences
  // the schedule, not an operator's explicit run.
  const scheduler = createScheduler({
    jobs: JOBS,
    config,
    cron: {
      schedule: () => {
        throw new Error('one-shot run must not register cron tasks');
      },
      stop: () => undefined,
    },
    logger: consoleLogger,
    registerSchedules: false,
  });

  try {
    const result = await scheduler.runJob(jobName);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`scheduler run ${jobName} failed: ${describeError(error)}\n`);
    process.exit(1);
  }
}

function runList(): void {
  for (const job of JOBS) {
    process.stdout.write(`${job.name}\t${job.schedule}\t${job.timezone}\t${job.webPath ?? ''}\n`);
  }
}

async function main(): Promise<void> {
  const [command, ...commandArgs] = process.argv.slice(2);

  switch (command) {
    case 'start':
      await runStart();
      return;
    case 'run':
      await runOneJob(commandArgs[0]);
      return;
    case 'list':
      runList();
      return;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printUsage();
      return;
    default:
      process.stderr.write(`scheduler: unknown command ${JSON.stringify(command)}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  if (error instanceof SchedulerConfigError) {
    process.stderr.write(`scheduler: ${error.message}\n`);
  } else {
    process.stderr.write(`scheduler: ${describeError(error)}\n`);
  }
  process.exit(1);
});
