export * from './types';
export * from './session';
export * from './transport';
export * from './lights';

import type { BleConnector, BleOpenOptions, BoardBleProtocol, BoardBleSession } from './types';
import { throwIfAborted } from './session';

/** The connector owns scan/permission UI and platform connection deadlines. */
export async function connectBoard<Session extends BoardBleSession>(
  protocol: BoardBleProtocol<Session>,
  connector: BleConnector,
  deviceId: string,
  options: BleOpenOptions = {},
): Promise<Session> {
  throwIfAborted(options.signal);
  const transport = await connector.connect(deviceId, options.signal);
  // A platform connect can finish after cancellation. Never leak that late link.
  if (options.signal?.aborted) {
    await transport.disconnect().catch(() => undefined);
    throwIfAborted(options.signal);
  }
  // Protocol.open owns cleanup once handed the transport, including failed setup.
  return protocol.open(transport, options);
}
