import type { RuntimeReceipt } from './isolated-runtime';
import { RehearsalSafetyError } from './target-guard';

export async function readRuntimeReceipt(): Promise<RuntimeReceipt> {
  if (process.argv.length !== 2) throw new RehearsalSafetyError('ISOLATED_ENTRY_ARGUMENTS_REFUSED');
  let serialized = '';
  for await (const chunk of process.stdin) {
    serialized += String(chunk);
    if (serialized.length > 1024) throw new RehearsalSafetyError('ISOLATED_ENTRY_RECEIPT_REFUSED');
  }
  const receipt: unknown = JSON.parse(serialized);
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(',') !== 'networkNamespace,postgresPassword,redisPassword,runNonce' ||
    Object.values(receipt).some((field) => typeof field !== 'string')
  )
    throw new RehearsalSafetyError('ISOLATED_ENTRY_RECEIPT_REFUSED');
  return receipt as RuntimeReceipt;
}
