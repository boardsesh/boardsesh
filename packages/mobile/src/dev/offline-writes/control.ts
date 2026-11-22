import { parseQaRequest, type QaRequest } from './cases';

export type QaHostCommand = QaRequest & { reloadRuntimeId?: string };

export function parseQaHostCommand(command: Record<string, unknown>, port: number): QaHostCommand {
  const request = parseQaRequest(command);
  if (request.receiptPort !== port) throw new Error('QA command receipt port mismatch');
  if (command.reloadRuntimeId === undefined) return request;
  if (
    request.phase !== 'prepare-reload' ||
    typeof command.reloadRuntimeId !== 'string' ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(command.reloadRuntimeId)
  )
    throw new Error('Invalid QA reload target');
  return { ...request, reloadRuntimeId: command.reloadRuntimeId };
}

/** Retain this receiver at module scope, so a route remount cannot reload twice. */
export function createQaRuntimeReload(runtimeId: string, reload: () => void) {
  const requestedRuns = new Set<string>();
  return (command: QaHostCommand | undefined): void => {
    if (
      command?.phase !== 'prepare-reload' ||
      command.reloadRuntimeId !== runtimeId ||
      requestedRuns.has(command.runId)
    )
      return;
    requestedRuns.add(command.runId);
    // Never await the prepare Promise: it deliberately holds the native writer.
    reload();
  };
}

/** A durable loopback command survives JS startup and reload without OS dialogs. */
export function startQaCommandPolling(port: number, receive: (request: QaHostCommand) => void): () => void {
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
        receive(parseQaHostCommand(command as Record<string, unknown>, port));
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
