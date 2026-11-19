import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'vite-plus/test';

it('samples normal GraphQL, keeps fixed diagnostics and omits private feedback span data', async () => {
  const fixture = fileURLToPath(new URL('./helpers/private-feedback-tracing.ts', import.meta.url));
  await promisify(execFile)(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), fixture]);
}, 20_000);
