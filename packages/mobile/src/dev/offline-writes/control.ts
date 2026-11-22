import { parseQaRequest, type QaRequest } from './cases';

/** A durable loopback command survives JS startup and reload without OS dialogs. */
export function startQaCommandPolling(port: number, receive: (request: QaRequest) => void): () => void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid QA control port');
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  async function poll() {
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 3000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/command`, { signal: controller.signal });
      if (!response.ok) throw new Error('QA command transport failed');
      const command: unknown = await response.json();
      if (!stopped && command !== null && typeof command === 'object' && !Array.isArray(command)) {
        const request = parseQaRequest(command as Record<string, unknown>);
        if (request.receiptPort !== port) throw new Error('QA command receipt port mismatch');
        receive(request);
      }
    } catch {
      // The host can start after JS or be briefly unavailable during teardown.
      // Its fixed phase deadline still fails the run if no command is delivered.
    } finally {
      clearTimeout(deadline);
      if (!stopped) retry = setTimeout(() => void poll(), 500);
    }
  }
  void poll();
  return () => {
    stopped = true;
    clearTimeout(retry);
    controller?.abort();
  };
}
