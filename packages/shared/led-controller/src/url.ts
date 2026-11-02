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
