import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { createServer } from 'node:net';

/** A foreign Metro must never supply this recorder's bundle or backend settings. */
export async function assertTutorialMetroPortFree(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid tutorial Metro port.');
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', () => reject(new Error(`Tutorial Metro port ${port} is occupied; choose a free port.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

export async function warmTutorialMetro(child: ChildProcess, port: number): Promise<void> {
  const controller = new AbortController();
  let childFailure: Error | undefined;
  const failed = (error: Error) => {
    childFailure = error;
    controller.abort(error);
  };
  child.once('error', failed);
  child.once('exit', (code, signal) => failed(new Error(`Tutorial Metro exited (${code ?? signal}); see metro.log.`)));
  const assertOwnedChild = () => {
    if (childFailure) throw childFailure;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Tutorial Metro is no longer running.');
  };
  const request = (url: string, timeout: number, headers?: Record<string, string>) => {
    assertOwnedChild();
    return fetch(url, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
  };
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    assertOwnedChild();
    try {
      const status = await request(`${origin}/status`, 2000);
      ready = status.ok && (await status.text()).includes('packager-status:running');
    } catch {
      assertOwnedChild();
    }
    if (ready) break;
    await new Promise<void>((done) => setTimeout(done, 500));
  }
  if (!ready) throw new Error('Timed out waiting for owned tutorial Metro.');
  console.log(`[tutorial] Prewarming Android bundle from ${origin}`);
  const manifest = await request(`${origin}/`, 60_000, {
    'expo-platform': 'android',
    accept: 'application/expo+json',
  });
  if (!manifest.ok) throw new Error(`Metro manifest failed: HTTP ${manifest.status}`);
  const bundleUrl = ((await manifest.json()) as { launchAsset?: { url?: string } }).launchAsset?.url;
  if (!bundleUrl || new URL(bundleUrl).origin !== origin)
    throw new Error('Metro Android launch asset must come from the owned loopback port.');
  const bundle = await request(bundleUrl, 300_000);
  if (!bundle.ok) throw new Error(`Android bundle failed: HTTP ${bundle.status}`);
  await bundle.arrayBuffer();
  assertOwnedChild();
}

export async function listenTutorialSignals(server: Server, onError: (error: Error) => void): Promise<void> {
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      ready();
    });
  });
  server.on('error', onError);
}

/** Links come from authored recipes or the local dev-client URL, not external input. */
export function openTutorialLink(
  adb: string,
  serial: string,
  link: string,
  command: (binary: string, args: string[]) => string,
): void {
  const guestQuotedLink = "'" + link.replaceAll("'", "'\\''") + "'";
  command(adb, ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', guestQuotedLink]);
}
