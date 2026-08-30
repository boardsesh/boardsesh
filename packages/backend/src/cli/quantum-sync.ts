#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { closePool } from '@boardsesh/db/client';
import { syncQuantumCatalogOnce } from '../services/quantum-catalog-sync';

export async function runQuantumSyncCli(
  argv: readonly string[],
  runtime: {
    log?: (message: string) => void;
    error?: (message: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  parseCommand(argv);
  const log = runtime.log ?? writeStdout;
  await syncQuantumCatalogOnce({ signal: runtime.signal, log });
}

function parseCommand(argv: readonly string[]): void {
  const command = argv[0];
  if (command === 'once' && argv.length === 1) return;
  throw new Error('Usage: quantum-sync once. Scheduled sync runs through the quantum-catalog-sync background job.');
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (signal: string) => {
    writeStdout(`[QuantumSync] received ${signal}; stopping`);
    controller.abort();
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    await runQuantumSyncCli(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    writeStderr(`[QuantumSync] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}
