#!/usr/bin/env node
import { program } from 'commander';
import { SyncRunner } from '../runner/sync-runner';
import { AURORA_BOARDS } from '../api/types';
import { AURORA_LOCATION_BOARDS, type AuroraLocationBoardName } from '../sync/locations-sync';

// Load environment variables from .env files if available
import { config } from 'dotenv';
config({ path: '.env.local' });
config({ path: '.env' });

const AURORA_BOARD_OPTIONS = AURORA_BOARDS.join(', ');

function createRunner(verbose: boolean): SyncRunner {
  return new SyncRunner({
    onLog: verbose
      ? console.info
      : (msg: string) => {
          if (
            msg.includes('✓') ||
            msg.includes('✗') ||
            msg.includes('Found') ||
            msg.includes('Daemon') ||
            msg.includes('Quiet hours') ||
            msg.includes('Waiting') ||
            msg.includes('No users') ||
            msg.includes('Transient')
          ) {
            console.info(msg);
          }
        },
    onError: (error, context) => {
      console.error(`Error syncing ${context.userId ?? 'daemon'}/${context.board ?? 'unknown'}:`, error.message);
    },
  });
}

function installDaemonSignalHandlers(runner: SyncRunner): () => void {
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`\nReceived ${signal}. Stopping Aurora sync daemon...`);
    void runner.close();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  return () => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

program.name('aurora-sync').description('Aurora board sync utility for Boardsesh').version('1.0.0');

program
  .command('all')
  .description('Sync all users with syncable Aurora credentials')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const runner = createRunner(options.verbose);

    try {
      console.info('Starting Aurora sync for all users...\n');
      const result = await runner.syncAllUsers();

      console.info('\n=== Sync Summary ===');
      console.info(`Total users: ${result.total}`);
      console.info(`Successful: ${result.successful}`);
      console.info(`Failed: ${result.failed}`);

      if (result.errors.length > 0) {
        console.info('\nErrors:');
        result.errors.forEach((err) => {
          console.info(`  - ${err.userId} (${err.boardType}): ${err.error}`);
        });
      }

      await runner.close();
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      console.error('Fatal error:', error);
      await runner.close();
      process.exit(1);
    }
  });

program
  .command('daemon')
  .description('Run Aurora sync continuously with Sydney quiet hours and random delays')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const runner = createRunner(options.verbose);
    const removeSignalHandlers = installDaemonSignalHandlers(runner);

    try {
      console.info('Starting Aurora sync daemon...\n');
      await runner.runDaemon();
      removeSignalHandlers();
      await runner.close();
      process.exit(0);
    } catch (error) {
      removeSignalHandlers();
      console.error('Fatal daemon error:', error);
      await runner.close();
      process.exit(1);
    }
  });

program
  .command('user <userId>')
  .description('Sync a specific user by NextAuth user ID')
  .option('-b, --board <type>', `Board type (${AURORA_BOARD_OPTIONS})`, 'kilter')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (userId: string, options) => {
    const runner = createRunner(options.verbose);

    try {
      console.info(`Syncing user ${userId} for ${options.board}...`);
      await runner.syncUser(userId, options.board);
      console.info('Sync completed successfully!');
      await runner.close();
      process.exit(0);
    } catch (error) {
      console.error('Sync failed:', error instanceof Error ? error.message : error);
      await runner.close();
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all users with Aurora credentials')
  .action(async () => {
    const { createDb, closePool } = await import('@boardsesh/db/client');
    const { auroraCredentials } = await import('@boardsesh/db/schema/auth');

    const db = createDb();

    try {
      const credentials = await db
        .select({
          userId: auroraCredentials.userId,
          boardType: auroraCredentials.boardType,
          auroraUserId: auroraCredentials.auroraUserId,
          syncStatus: auroraCredentials.syncStatus,
          lastSyncAt: auroraCredentials.lastSyncAt,
          syncError: auroraCredentials.syncError,
        })
        .from(auroraCredentials);

      console.info('\n=== Aurora Credentials ===\n');

      if (credentials.length === 0) {
        console.info('No credentials found.');
      } else {
        credentials.forEach((cred) => {
          let status = '○';
          if (cred.syncStatus === 'active') {
            status = '✓';
          } else if (cred.syncStatus === 'error') {
            status = '✗';
          }
          const lastSync = cred.lastSyncAt ? new Date(cred.lastSyncAt).toISOString() : 'never';
          console.info(`${status} ${cred.userId} (${cred.boardType})`);
          console.info(`    Aurora ID: ${cred.auroraUserId}`);
          console.info(`    Status: ${cred.syncStatus}`);
          console.info(`    Last sync: ${lastSync}`);
          if (cred.syncError) {
            console.info(`    Error: ${cred.syncError}`);
          }
          console.info('');
        });
      }

      await closePool();
    } catch (error) {
      console.error('Error listing credentials:', error);
      await closePool();
      process.exit(1);
    }
  });

program
  .command('locations')
  .description('Sync public Aurora board gym locations into gyms / user_boards')
  .option('-b, --board <type>', `Board type (${AURORA_LOCATION_BOARDS.join(', ')}, all)`, 'all')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options: { board: string; verbose?: boolean }) => {
    const runner = createRunner(options.verbose ?? false);
    try {
      const board = options.board.trim();
      if (board !== 'all' && !AURORA_LOCATION_BOARDS.includes(board as AuroraLocationBoardName)) {
        console.error(`Invalid board: ${board}. Expected one of ${AURORA_LOCATION_BOARDS.join(', ')} or all.`);
        await runner.close();
        process.exit(1);
      }
      const summary = await runner.syncLocations(board === 'all' ? 'all' : (board as AuroraLocationBoardName));
      console.info('✓ Aurora location sync complete:', JSON.stringify(summary, null, 2));
      await runner.close();
    } catch (error) {
      console.error('Location sync failed:', error instanceof Error ? error.message : error);
      await runner.close();
      process.exit(1);
    }
  });

program.parse();
