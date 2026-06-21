#!/usr/bin/env node
/* eslint-disable no-console */
import 'dotenv/config';
import { Command } from 'commander';
import { createDb, closePool } from '@boardsesh/db/client';
import { syncMoonBoardLocations } from '../sync/locations-sync';

const program = new Command();
program.name('moonboard-sync').description('MoonBoard sync utility for Boardsesh').version('1.0.0');

program
  .command('locations')
  .description('Sync public MoonBoard gym locations into gyms / user_boards')
  .option('--username <username>', 'MoonBoard username; defaults to MOONBOARD_USERNAME')
  .option('--password <password>', 'MoonBoard password; defaults to MOONBOARD_PASSWORD')
  .option('--skip-if-missing-credentials', 'exit successfully when MoonBoard credentials are not configured')
  .option('-v, --verbose', 'verbose logging')
  .action(
    async (options: {
      username?: string;
      password?: string;
      skipIfMissingCredentials?: boolean;
      verbose?: boolean;
    }) => {
      const username = options.username ?? process.env.MOONBOARD_USERNAME;
      const password = options.password ?? process.env.MOONBOARD_PASSWORD;
      if (!username || !password) {
        if (options.skipIfMissingCredentials) {
          console.log('Skipping MoonBoard location sync: MOONBOARD_USERNAME/MOONBOARD_PASSWORD are not configured.');
          return;
        }
        console.error(
          'MoonBoard credentials are required: pass --username/--password or set MOONBOARD_USERNAME/MOONBOARD_PASSWORD.',
        );
        process.exit(1);
      }

      try {
        const db = createDb();
        const summary = await syncMoonBoardLocations({
          db,
          username,
          password,
          log: options.verbose ? (message) => console.info(message) : undefined,
        });
        console.info('✓ MoonBoard location sync complete:', JSON.stringify(summary, null, 2));
        await closePool();
      } catch (error) {
        console.error('✗ MoonBoard location sync failed:', error instanceof Error ? error.message : error);
        await closePool();
        process.exit(1);
      }
    },
  );

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
