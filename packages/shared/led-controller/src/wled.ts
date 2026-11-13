import { LedControllerError, type LedControllerDriver } from './types';
import { normalizeLocalControllerUrl } from './url';
import { createWledCommandDriver } from './wled-commands';

export interface WledDriverOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createWledDriver(options: WledDriverOptions = {}): LedControllerDriver {
  const fetchController = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid WLED timeout');

  async function request(
    url: string,
    path: 'info' | 'state',
    signal?: AbortSignal,
    command?: Record<string, unknown>,
  ): Promise<unknown> {
    const baseUrl = normalizeLocalControllerUrl(url);
    if (signal?.aborted) throw new LedControllerError('cancelled');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onCancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onCancel = () => {
        reject(new LedControllerError('cancelled'));
        controller.abort();
      };
      signal?.addEventListener('abort', onCancel, { once: true });
      timeout = setTimeout(() => {
        reject(new LedControllerError('timeout'));
        controller.abort();
      }, timeoutMs);
    });
    const exchange = async (): Promise<unknown> => {
      try {
        const response = await fetchController(`${baseUrl}/json/${path}`, {
          method: command ? 'POST' : 'GET',
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          headers: command
            ? { Accept: 'application/json', 'Content-Type': 'application/json' }
            : { Accept: 'application/json' },
          ...(command ? { body: JSON.stringify(command) } : {}),
        });
        if (!response.ok) throw new LedControllerError(command ? 'command-failed' : 'unavailable');
        try {
          return await response.json();
        } catch {
          throw new LedControllerError(command ? 'command-failed' : 'not-wled');
        }
      } catch (error) {
        if (error instanceof LedControllerError) throw error;
        throw new LedControllerError('unavailable');
      }
    };
    try {
      return await Promise.race([exchange(), interrupted]);
    } finally {
      clearTimeout(timeout);
      if (onCancel) signal?.removeEventListener('abort', onCancel);
    }
  }

  return createWledCommandDriver(request);
}

export const wledDriver = createWledDriver();
