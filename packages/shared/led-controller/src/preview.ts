import { type LedControllerDriver, type LedControllerPreviewTransport } from './types';
import { normalizeControllerUrl } from './url';

type Lane = {
  tail: Promise<unknown>;
  owner: symbol | null;
  users: number;
  transport: LedControllerPreviewTransport | null;
};
const lanes = new Map<string, Lane>();

/** Latest selection wins; HTTP writes never overlap, including across screens. */
export function createLedPreviewSession(driver: LedControllerDriver, controllerUrl: string) {
  const url = normalizeControllerUrl(controllerUrl);
  const lane = lanes.get(url) ?? { tail: Promise.resolve(), owner: null, users: 0, transport: null };
  lanes.set(url, lane);
  lane.users++;
  const token = Symbol('LED preview');
  let generation = 0;
  let closed = false;

  function enqueue(operation: () => Promise<boolean>) {
    const pending = lane.tail.catch(() => undefined).then(operation);
    lane.tail = pending;
    return pending;
  }

  function run(operation: (preview: LedControllerPreviewTransport) => Promise<void>) {
    if (closed) return Promise.resolve(false);
    const request = ++generation;
    lane.owner = token;
    return enqueue(async () => {
      if (closed || request !== generation || lane.owner !== token) return false;
      // The lane records what reached the controller. Queued ownership changes
      // cannot discard the transport while an earlier write is in flight.
      const transport = (lane.transport ??= driver.createPreview(url));
      try {
        await operation(transport);
        return !closed && request === generation && lane.owner === token;
      } catch (error) {
        // The device may have applied a command whose response was lost. Clear
        // after that request settles, never concurrently with an in-flight POST.
        try {
          await transport.turnOff();
          lane.transport = null;
        } catch {
          // Keep this transport available for a later cleanup retry.
        }
        throw error;
      }
    });
  }

  function stop() {
    const request = ++generation;
    return enqueue(async () => {
      if (request !== generation || lane.owner !== token) return false;
      const transport = lane.transport;
      if (transport) await transport.turnOff();
      lane.transport = null;
      if (request === generation && lane.owner === token) lane.owner = null;
      return transport !== null;
    });
  }

  return {
    isOwner: () => lane.owner === token,
    show: (indices: readonly number[]) => {
      const snapshot = [...indices];
      return snapshot.length ? run((preview) => preview.show(snapshot)) : stop();
    },
    lightAll: () => run((preview) => preview.lightAll()),
    stop,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await stop();
      } finally {
        lane.users--;
        if (lane.users === 0 && lanes.get(url) === lane) lanes.delete(url);
      }
    },
  };
}

export type LedPreviewSession = ReturnType<typeof createLedPreviewSession>;
