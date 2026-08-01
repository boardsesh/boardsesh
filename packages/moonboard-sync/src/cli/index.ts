#!/usr/bin/env node
/* eslint-disable no-console */
import 'dotenv/config';
import { Command } from 'commander';
import { MoonBoardSyncRunner } from '../runner/sync-runner';

type CredentialOptions = {
  username?: string;
  password?: string;
  skipIfMissingCredentials?: boolean;
  verbose?: boolean;
};

function resolveCredentials(options: CredentialOptions): { username: string; password: string } | null {
  const username = options.username ?? process.env.MOONBOARD_USERNAME;
  const password = options.password ?? process.env.MOONBOARD_PASSWORD;
  if (username && password) return { username, password };

  if (options.skipIfMissingCredentials) {
    console.log('Skipping MoonBoard location sync: MOONBOARD_USERNAME/MOONBOARD_PASSWORD are not configured.');
    return null;
  }

  console.error(
    'MoonBoard credentials are required: pass --username/--password or set MOONBOARD_USERNAME/MOONBOARD_PASSWORD.',
  );
  process.exitCode = 1;
  return null;
}

function createRunner(credentials: { username: string; password: string }, verbose = false): MoonBoardSyncRunner {
  return new MoonBoardSyncRunner({
    ...credentials,
    onLog: verbose ? (message) => console.info(message) : undefined,
  });
}

function addCredentialOptions(command: Command): Command {
  return command
    .option('--username <username>', 'MoonBoard username; defaults to MOONBOARD_USERNAME')
    .option('--password <password>', 'MoonBoard password; defaults to MOONBOARD_PASSWORD')
    .option('--skip-if-missing-credentials', 'exit successfully when MoonBoard credentials are not configured')
    .option('-v, --verbose', 'verbose logging');
}

const program = new Command();
program.name('moonboard-sync').description('MoonBoard sync utility for Boardsesh').version('1.0.0');

addCredentialOptions(
  program.command('locations').description('Sync public MoonBoard gym locations into gyms / user_boards'),
).action(async (options: CredentialOptions) => {
  const credentials = resolveCredentials(options);
  if (!credentials) return;

  const runner = createRunner(credentials, options.verbose);
  try {
    const summary = await runner.syncLocations();
    console.info('✓ MoonBoard location sync complete:', JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('✗ MoonBoard location sync failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await runner.stop();
  }
});

addCredentialOptions(
  program.command('daemon').description('Run the recurring MoonBoard public-location sync daemon'),
).action(async (options: CredentialOptions) => {
  const credentials = resolveCredentials(options);
  if (!credentials) return;

  const runner = createRunner(credentials, options.verbose);
  const handleSignal = (signal: string) => () => {
    console.info(`Received ${signal}. Stopping MoonBoard location sync daemon...`);
    // Abort the loop but let an in-flight location apply settle. The action's
    // finally block performs lease and pool cleanup after runDaemon resolves.
    runner.requestStop();
  };
  const handleSigint = handleSignal('SIGINT');
  const handleSigterm = handleSignal('SIGTERM');
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  try {
    console.info('Starting MoonBoard location sync daemon...');
    await runner.runDaemon();
  } catch (error) {
    console.error('MoonBoard location sync daemon exited with error:', error);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    await runner.stop();
  }
});

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
