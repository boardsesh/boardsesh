import { LedControllerError } from './types';

/** A controller base URL, including an optional reverse-proxy path. */
export function normalizeControllerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || /[\s\\?#]/u.test(trimmed)) throw new LedControllerError('invalid-url');
  // A bare LAN hostname/IP is convenient, but a malformed scheme is not one.
  if (/^https?:/iu.test(trimmed) && !/^https?:\/\//iu.test(trimmed)) {
    throw new LedControllerError('invalid-url');
  }
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new LedControllerError('invalid-url');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(parsed.pathname)
  ) {
    throw new LedControllerError('invalid-url');
  }
  return parsed.toString().replace(/\/+$/u, '');
}

/** Only names and addresses that resolve inside the LAN the phone is on. */
const LOCAL_HOSTNAME_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal'];
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isLocalIpv6(address: string): boolean {
  if (!/^[0-9a-f:.]+$/u.test(address)) return false;
  // `::1`, `::ffff:192.168.1.1` and friends start with an empty group: not LAN devices.
  const firstGroup = Number.parseInt(address.split(':')[0], 16);
  if (Number.isNaN(firstGroup)) return false;
  const uniqueLocal = (firstGroup & 0xfe00) === 0xfc00;
  const linkLocal = (firstGroup & 0xffc0) === 0xfe80;
  return uniqueLocal || linkLocal;
}

/** A host a phone can only reach on its own network; never one that resolves on the public internet. */
export function isLocalControllerHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) return isLocalIpv6(host.slice(1, -1));
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    const octets = host.split('.').map(Number);
    return octets.every((octet) => octet <= 255) && isPrivateIpv4(octets);
  }
  if (host.length > 253 || host === 'localhost') return false;
  const labels = host.split('.');
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return false;
  // Numbers a URL parser did not turn into a dotted address (`2130706433`, `0x7f.1`).
  if (labels.every((label) => /^(?:\d+|0x[0-9a-f]*)$/u.test(label))) return false;
  // A bare name is out: some are public TLDs (`http://ai`), and a phone may
  // complete the rest with whatever search domain its network hands out.
  return LOCAL_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * A base URL that may be stored on a shared wall and contacted by another
 * climber's phone. Everything `normalizeControllerUrl` refuses, plus any host
 * that is not on the local network.
 */
export function normalizeLocalControllerUrl(input: string): string {
  const normalized = normalizeControllerUrl(input);
  if (!isLocalControllerHost(new URL(normalized).hostname)) throw new LedControllerError('not-local');
  return normalized;
}
