import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTailscaleHostname } from '../../../scripts/lib/tailscale-hostname';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(scriptDirectory, '../../..');

const DEFAULT_WEB_PORT = '3000';
const DEFAULT_BACKEND_PORT = '8080';

function setDefaultEnv(key: string, value: string): void {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// Force-override even if .env.local set the value. The committed .env.local pins
// localhost:3000 as a generic dev default, which is wrong for Tailscale + auto-
// incremented ports — next-auth's client tries to fetch a session URL that
// doesn't match the page origin and Safari throws "string did not match the
// expected pattern" on URL parsing.
function overrideEnv(key: string, value: string): void {
  process.env[key] = value;
}

function applyGeneratedDevDbEnv(): void {
  const envFile = join(rootDirectory, '.boardsesh', 'dev-db.env');
  if (!existsSync(envFile)) return;

  const inheritedKeys = new Set(Object.keys(process.env));
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmedLine.slice(0, separatorIndex);
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (inheritedKeys.has(key)) continue;

    process.env[key] = trimmedLine.slice(separatorIndex + 1);
  }
}

function main(): void {
  applyGeneratedDevDbEnv();

  const webPort = process.env.PORT || DEFAULT_WEB_PORT;
  const backendPort = process.env.BACKEND_PORT || DEFAULT_BACKEND_PORT;
  const resolution = resolveTailscaleHostname();

  // HTTPS mode: orchestrator has provisioned a Tailscale cert and injected
  // DEV_HTTPS_CERT_FILE / DEV_HTTPS_KEY_FILE. Both must be present to switch
  // schemes; otherwise stay on HTTP so non-Tailscale devs are unaffected.
  const certFile = process.env.DEV_HTTPS_CERT_FILE;
  const keyFile = process.env.DEV_HTTPS_KEY_FILE;
  const tlsEnabled = !!(certFile && keyFile);
  const httpScheme = tlsEnabled ? 'https' : 'http';
  const wsScheme = tlsEnabled ? 'wss' : 'ws';

  const webOrigin = `${httpScheme}://${resolution.hostname}:${webPort}`;
  setDefaultEnv('NEXT_PUBLIC_WS_URL', `${wsScheme}://${resolution.hostname}:${backendPort}/graphql`);
  // Override (not setDefault) — the .env.local localhost:3000 default mismatches
  // the actual page origin in Tailscale / auto-incremented-port mode.
  overrideEnv('NEXTAUTH_URL', webOrigin);
  overrideEnv('BASE_URL', webOrigin);

  console.info(`[dev] Hostname: ${resolution.hostname} (${resolution.source})`);
  if (resolution.reason) {
    console.info(`[dev] ${resolution.reason}`);
  }
  console.info(`[dev] Web URL: ${httpScheme}://${resolution.hostname}:${webPort}`);
  console.info(`[dev] Backend WS URL: ${process.env.NEXT_PUBLIC_WS_URL}`);
  if (tlsEnabled) {
    console.info('[dev] TLS: serving via Next.js --experimental-https with Tailscale cert');
  }

  // Bind all interfaces in both modes. Binding the MagicDNS hostname sounds
  // right for TLS, but on macOS Tailscale resolves the machine's OWN name to
  // 127.0.0.1, so Next would listen on loopback only and every other tailnet
  // device gets connection-refused. The cert covers the ts.net name either
  // way; the printed Web URL (above) is the one users should open.
  const bindHostname = '0.0.0.0';
  const nextArgs = ['dev', '--hostname', bindHostname, '--turbopack'];
  if (tlsEnabled) {
    // Next.js requires --experimental-https to switch the dev server into
    // HTTPS mode; the cert+key flags then point at the files to use instead
    // of auto-generating a self-signed one. Without --experimental-https the
    // other two flags are silently ignored and the banner still says http://.
    nextArgs.push('--experimental-https', '--experimental-https-cert', certFile!, '--experimental-https-key', keyFile!);
  }

  const nextProcess = spawn('next', nextArgs, {
    env: process.env,
    stdio: 'inherit',
  });

  nextProcess.on('error', (error) => {
    console.error('[dev] Failed to start Next.js dev server:', error);
    process.exit(1);
  });

  nextProcess.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
