import { enterIsolatedRuntime } from './isolated-runtime';
import { prepareOwnedDatabase, type OwnedDatabase } from './database';
import { startRehearsalWorker, type RehearsalWorker } from './processes';
import { runRaces } from './races';
import { readRuntimeReceipt } from './runtime-receipt';
import { RehearsalSafetyError } from './target-guard';

async function main() {
  const target = await enterIsolatedRuntime(await readRuntimeReceipt());
  let database: OwnedDatabase | undefined;
  const workers: RehearsalWorker[] = [];
  let report: Awaited<ReturnType<typeof runRaces>> | undefined;
  let failure: unknown;
  try {
    database = await prepareOwnedDatabase(target);
    workers.push(await startRehearsalWorker(target));
    workers.push(await startRehearsalWorker(target));
    report = await runRaces(database, workers[0], workers[1]);
  } catch (error) {
    failure = error;
  }
  const cleanupFailures: unknown[] = [];
  for (const worker of workers) {
    try {
      await worker.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await database?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length) throw new RehearsalSafetyError('ISOLATED_ENTRY_CLEANUP_FAILED');
  if (failure) throw failure;
  if (!report) throw new RehearsalSafetyError('ISOLATED_ENTRY_REPORT_REQUIRED');
  console.log(JSON.stringify(report));
}
void main().catch((error: unknown) => {
  console.error(error instanceof RehearsalSafetyError ? error.code : 'ISOLATED_REHEARSAL_FAILED');
  process.exitCode = 1;
});
