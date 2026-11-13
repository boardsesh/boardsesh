import {
  parseCapabilities,
  validateLightingState,
  type WledBleConnection,
  type WledBleConnector,
} from '@boardsesh/wled-ble-protocol';
import { LedControllerError, type LedControllerDriver, type LedControllerPreviewTransport } from './types';
import { normalizeWledBleTarget } from './url';
import { createWledCommandDriver } from './wled-commands';
import { snapshotLedPixels } from './led-pixels';

const lanes = new Map<string, Promise<unknown>>();

/** The native connector must bound disconnect and tear down subscriptions before resolving it. */
export function createWledBleDriver(connector: WledBleConnector): LedControllerDriver {
  async function operation<Result>(
    target: string,
    signal: AbortSignal | undefined,
    apply: (driver: LedControllerDriver) => Promise<Result>,
  ): Promise<Result> {
    const normalized = normalizeWledBleTarget(target);
    const controllerId = normalized.slice('wled-ble:'.length);
    const previous = lanes.get(controllerId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        if (signal?.aborted) throw new LedControllerError('cancelled');
        let connection: WledBleConnection | undefined;
        try {
          connection = await connector.connect(controllerId, signal);
          const capabilities = parseCapabilities(connection.capabilities);
          if (capabilities.controllerId !== controllerId) throw new LedControllerError('not-wled');
          if (signal?.aborted) throw new LedControllerError('cancelled');
          const active = connection;
          const commands = createWledCommandDriver(async (_target, path, requestSignal, command) => {
            if (signal?.aborted || requestSignal?.aborted) throw new LedControllerError('cancelled');
            if (command) validateLightingState(command, capabilities.ledCount);
            return active.request(
              command ? 'setState' : path === 'info' ? 'getInfo' : 'getState',
              command,
              signal ?? requestSignal,
            );
          });
          return await apply(commands);
        } finally {
          if (connection) await connection.disconnect();
        }
      });
    lanes.set(controllerId, pending);
    try {
      return await pending;
    } finally {
      if (lanes.get(controllerId) === pending) lanes.delete(controllerId);
    }
  }
  const driver: LedControllerDriver = {
    probe: (target, signal) => operation(target, signal, (commands) => commands.probe(target, signal)),
    lightAll: (target, signal) => operation(target, signal, (commands) => commands.lightAll(target, signal)),
    turnOff: (target, signal) => operation(target, signal, (commands) => commands.turnOff(target, signal)),
    createPreview(target): LedControllerPreviewTransport {
      return {
        show(indices, pixels) {
          const snapshot = [...indices];
          const colors = snapshotLedPixels(snapshot, pixels);
          // A fresh command context re-arms brightness/nightlight and clears the
          // whole segment on every connection. Another phone may have changed it.
          return operation(target, undefined, (commands) => commands.createPreview(target).show(snapshot, colors));
        },
        lightAll: () => driver.lightAll(target),
        turnOff: () => driver.turnOff(target),
      };
    },
  };
  return driver;
}
