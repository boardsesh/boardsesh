import type { ConnectionState } from '../ui/ConnectionPill';
import { useBluetooth } from './bluetooth-provider';

/** The board link as the connection pill shows it. */
export function useConnectionState(): ConnectionState {
  const { status, scanning, problem } = useBluetooth();
  if (status === 'connected') return 'connected';
  if (status === 'connecting' || scanning) return 'scanning';
  if (problem) return 'error';
  return 'disconnected';
}
