import 'server-only';
import { PLAIN_SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME } from './secure-cookies';

/** Cookie possession only. A missing family differs from any refused family;
 * authorization headers and client identity claims are never a fallback. */
export function readBootstrapLegacyCredential(cookieHeader: string | null): string | null {
  const header = cookieHeader ?? '';
  if (Buffer.byteLength(header, 'utf8') > 32_768) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  for (let index = 0; index < header.length; index++) {
    if (header.charCodeAt(index) < 32 || header.charCodeAt(index) === 127) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  }
  const pieces = header.split(';');
  if (pieces.length > 128) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  const names = [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME];
  const selected: { name: string; content: string }[] = [];
  for (const piece of pieces) {
    const pair = piece.trim();
    const separator = pair.indexOf('=');
    const name = (separator < 0 ? pair : pair.slice(0, separator)).trim();
    if (!names.some((base) => name.startsWith(base))) continue;
    if (separator < 0) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
    selected.push({ name, content: pair.slice(separator + 1) });
  }
  if (!selected.length) return null;
  const families = names.filter((base) => selected.some((entry) => entry.name.startsWith(base)));
  if (families.length !== 1 || new Set(selected.map((entry) => entry.name)).size !== selected.length)
    throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  const base = families[0];
  if (selected.some((entry) => entry.name === base)) {
    if (selected.length !== 1) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  } else {
    selected.sort(
      (left, right) => Number(left.name.slice(base.length + 1)) - Number(right.name.slice(base.length + 1)),
    );
    if (selected.some((entry, index) => entry.name !== `${base}.${index}`)) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  }
  if (selected.some((entry) => !entry.content)) throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  const credential = decodeURIComponent(selected.map((entry) => entry.content).join(''));
  if (!credential || Buffer.byteLength(credential) > 16_384 || !/^[\x21-\x7e]+$/.test(credential))
    throw new Error('BOOTSTRAP_COOKIE_REFUSED');
  return credential;
}
