#!/usr/bin/env node
/* eslint-disable no-console */
import 'dotenv/config';
import { Command } from 'commander';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

import { auroraCredentials } from '@boardsesh/db/schema';
import { SyncRunner } from '../runner';
import { KILTER_BOARD_TYPE } from '../api/types';

const program = new Command();
program.name('kilter-sync').description('Kilter Grips sync utility (Keycloak + PowerSync + REST)').version('1.0.0');

program
  .command('list')
  .description('List all users with kilter credentials')
  .action(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.error('DATABASE_URL is required');
      process.exit(1);
    }
    const client = postgres(connectionString, { max: 1, prepare: false });
    try {
      const db = drizzle(client);
      const rows = await db
        .select({
          userId: auroraCredentials.userId,
          syncStatus: auroraCredentials.syncStatus,
          syncError: auroraCredentials.syncError,
          lastSyncAt: auroraCredentials.lastSyncAt,
        })
        .from(auroraCredentials)
        .where(eq(auroraCredentials.boardType, KILTER_BOARD_TYPE));

      if (rows.length === 0) {
        console.log('No kilter credentials found.');
        return;
      }
      console.log(`${rows.length} kilter credential(s):`);
      for (const row of rows) {
        const lastSync = row.lastSyncAt ? row.lastSyncAt.toISOString() : 'never';
        const statusMark =
          row.syncStatus === 'active'
            ? '✓'
            : row.syncStatus === 'expired'
              ? '↻'
              : row.syncStatus === 'error'
                ? '✗'
                : '○';
        const err = row.syncError ? ` — ${row.syncError}` : '';
        console.log(`  ${statusMark} ${row.userId.padEnd(36)} ${(row.syncStatus ?? '').padEnd(8)} ${lastSync}${err}`);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });

program
  .command('user <userId>')
  .description('Force a kilter sync for one user (CLI escape hatch)')
  .action(async (userId: string) => {
    const runner = new SyncRunner({ onLog: (m) => console.info(m) });
    try {
      await runner.syncUser(userId);
      console.log(`✓ synced ${userId}`);
    } catch (err) {
      console.error(`✗ ${userId} failed:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    } finally {
      await runner.stop();
    }
  });

program
  .command('daemon')
  .description('Run the kilter sync daemon — one user per cycle, quiet hours, infinite loop')
  .action(async () => {
    const runner = new SyncRunner({ onLog: (m) => console.info(m) });
    const handle = (signal: string) => () => {
      console.log(`Received ${signal}, stopping…`);
      runner.stop().catch((err) => {
        console.error(err);
        process.exit(1);
      });
    };
    process.on('SIGINT', handle('SIGINT'));
    process.on('SIGTERM', handle('SIGTERM'));

    try {
      await runner.runDaemon();
    } catch (err) {
      console.error('Daemon exited with error:', err);
      process.exitCode = 1;
    } finally {
      await runner.stop();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
