#!/usr/bin/env node
import { program } from 'commander';
import { SyncRunner } from '../runner/sync-runner';

// Load environment variables from .env files if available
import { config } from 'dotenv';
config({ path: '.env.local' });
config({ path: '.env' });

program.name('aurora-sync').description('Aurora board sync utility for Boardsesh').version('1.0.0');

program
  .command('all')
  .description('Sync all users with active Aurora credentials')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const runner = new SyncRunner({
      onLog: options.verbose
        ? console.info
        : (msg: string) => {
            if (msg.includes('✓') || msg.includes('✗') || msg.includes('Found')) {
              console.info(msg);
            }
          },
      onError: (error, context) => {
        console.error(`Error syncing ${context.userId}/${context.board}:`, error.message);
      },
    });

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
  .command('user <userId>')
  .description('Sync a specific user by NextAuth user ID')
  .option('-b, --board <type>', 'Board type (kilter or tension)', 'kilter')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (userId: string, options) => {
    const runner = new SyncRunner({
      onLog: options.verbose ? console.info : () => {},
      onError: (error) => {
        console.error(`Error:`, error.message);
      },
    });

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
    // Import directly here to avoid circular deps
    const { createPool } = await import('@boardsesh/db/client');
    const { auroraCredentials } = await import('@boardsesh/db/schema/auth');
    const { drizzle } = await import('drizzle-orm/neon-serverless');

    const pool = createPool();
    const client = await pool.connect();

    try {
      const db = drizzle(client);
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
          const status = cred.syncStatus === 'active' ? '✓' : cred.syncStatus === 'error' ? '✗' : '○';
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

      await pool.end();
    } catch (error) {
      console.error('Error listing credentials:', error);
      await pool.end();
      process.exit(1);
    }
  });

program.parse();
