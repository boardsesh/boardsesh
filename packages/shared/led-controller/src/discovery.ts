import { LedControllerError, type LedControllerInfo } from './types';

/** At most one /24: a larger home subnet would mean thousands of probes. */
const MAX_HOSTS = 254;

function parseIpv4(address: string): number | null {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

/**
 * The addresses worth probing on the phone's Wi-Fi: every host of its subnet,
 * capped to the /24 around the phone, minus the phone itself. Private ranges
 * only, so a cellular or public address never starts a scan of strangers.
 */
export function wledScanHosts(ipAddress: string, subnetMask?: string | null): string[] {
  const ip = parseIpv4(ipAddress);
  if (ip === null || !isPrivateIpv4(ip)) return [];
  const mask = subnetMask ? parseIpv4(subnetMask) : null;
  // Prefix length of the mask; anything wider than /24 is narrowed to /24.
  let prefix = 24;
  if (mask !== null) {
    const bits = mask.toString(2).padStart(32, '0');
    if (/^1*0*$/u.test(bits)) prefix = Math.max(24, bits.indexOf('0') === -1 ? 32 : bits.indexOf('0'));
  }
  const size = 2 ** (32 - prefix);
  const network = ip - (ip % size);
  const hosts: string[] = [];
  for (let host = network + 1; host < network + size - 1 && hosts.length < MAX_HOSTS; host++) {
    if (host !== ip) hosts.push(formatIpv4(host));
  }
  return hosts;
}

function isPrivateIpv4(ip: number): boolean {
  const first = Math.floor(ip / 2 ** 24);
  const second = Math.floor(ip / 2 ** 16) % 256;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export type DiscoveredLedController = LedControllerInfo & { url: string };

export interface DiscoverOptions {
  /** Probe one base URL; resolves with its info or rejects. */
  probe: (url: string, signal: AbortSignal) => Promise<LedControllerInfo>;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (checked: number, total: number) => void;
  onFound?: (controller: DiscoveredLedController) => void;
}

/** Probe hosts a few at a time; controllers come back in address order. */
export async function discoverLedControllers(
  hosts: readonly string[],
  { probe, concurrency = 32, signal, onProgress, onFound }: DiscoverOptions,
): Promise<DiscoveredLedController[]> {
  const found: { order: number; controller: DiscoveredLedController }[] = [];
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let next = 0;
  let checked = 0;
  async function worker() {
    while (next < hosts.length && !abort.signal.aborted) {
      const order = next++;
      const url = `http://${hosts[order]}`;
      try {
        const info = await probe(url, abort.signal);
        if (abort.signal.aborted) return;
        const controller = { ...info, url };
        found.push({ order, controller });
        onFound?.(controller);
      } catch (error) {
        if (error instanceof LedControllerError && error.code === 'cancelled') return;
        // Nothing there, or not WLED: keep looking.
      }
      checked++;
      if (!abort.signal.aborted) onProgress?.(checked, hosts.length);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, hosts.length)) }, worker));
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  if (signal?.aborted) throw new LedControllerError('cancelled');
  return found.sort((left, right) => left.order - right.order).map(({ controller }) => controller);
}
