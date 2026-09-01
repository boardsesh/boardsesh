import { config } from 'dotenv';
import { join } from 'node:path';

/** Load the web app's tracked local defaults without replacing deploy-time env. */
export function loadWebLocalEnvironment(webRoot: string): void {
  config({ path: join(webRoot, '.env.local'), override: false, quiet: true });
}
