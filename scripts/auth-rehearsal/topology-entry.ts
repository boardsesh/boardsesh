import { enterIsolatedRuntime } from './isolated-runtime';
import { readRuntimeReceipt } from './runtime-receipt';
import { RehearsalSafetyError } from './target-guard';

// Intentionally no database bootstrap, SQL factory, worker or application imports.
void readRuntimeReceipt()
  .then(enterIsolatedRuntime)
  .then(() => {
    console.log('ISOLATED_TOPOLOGY_PROBE_PASS');
  })
  .catch((error: unknown) => {
    console.error(error instanceof RehearsalSafetyError ? error.code : 'ISOLATED_TOPOLOGY_PROBE_FAILED');
    process.exitCode = 1;
  });
