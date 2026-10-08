// The client-identity contract every Boardsesh client sends to the backend so
// the backend can tell its own apps apart from each other and from third-party
// clients. Identification only: the backend records it in the request context,
// its logs and a per-minute usage summary, and gates nothing on it. A missing
// or malformed value is bucketed as UNKNOWN_CLIENT.
//
// Transport rule:
//   - HTTP: the CLIENT_IDENTITY_HEADER request header.
//   - WebSocket: connectionParams[CLIENT_IDENTITY_CONNECTION_PARAM] on every
//     platform (browsers cannot set headers on the upgrade request).
//
// Wire grammar: `<name>/<version>` optionally followed by
// ` (<platform>[; build <build>])`, e.g.
//   boardsesh-mobile/2.6.0 (ios; build 45)
//   boardsesh-mobile-web/2.6.0 (web)
//   boardsesh-web/1.4.2

export const CLIENT_IDENTITY_HEADER = 'x-boardsesh-client';
export const CLIENT_IDENTITY_CONNECTION_PARAM = 'clientIdentity';
export const UNKNOWN_CLIENT = 'unknown';

/** Longest raw identity string the parser accepts. */
export const CLIENT_IDENTITY_MAX_LENGTH = 200;

export type ClientIdentity = {
  name: string;
  version: string;
  platform?: string;
  build?: string;
};

const CLIENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
// Version, platform and build are free-form but must not contain the grammar's
// own delimiters (whitespace, `/`, `(`, `)`, `;`).
const CLIENT_TOKEN_PATTERN = /^[^\s/();]+$/;
const CLIENT_IDENTITY_PATTERN = /^([^/\s]+)\/(\S+?)(?:\s+\(([^()]*)\))?$/;
const BUILD_SEGMENT_PATTERN = /^build\s+(\S+)$/i;

function isToken(candidate: string | undefined): candidate is string {
  return candidate !== undefined && CLIENT_TOKEN_PATTERN.test(candidate);
}

export function formatClientIdentity(identity: ClientIdentity): string {
  const base = `${identity.name}/${identity.version}`;
  if (!identity.platform) return base;
  const details = identity.build ? `${identity.platform}; build ${identity.build}` : identity.platform;
  return `${base} (${details})`;
}

export function parseClientIdentity(raw: string | null | undefined): ClientIdentity | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > CLIENT_IDENTITY_MAX_LENGTH) return undefined;

  const match = CLIENT_IDENTITY_PATTERN.exec(trimmed);
  if (!match) return undefined;
  const [, name, version, details] = match;
  if (!CLIENT_NAME_PATTERN.test(name) || !isToken(version)) return undefined;

  const identity: ClientIdentity = { name, version };
  if (details === undefined) return identity;

  const segments = details.split(';').map((segment) => segment.trim());
  const [platform, buildSegment, ...rest] = segments;
  if (rest.length > 0 || !isToken(platform)) return undefined;
  identity.platform = platform;

  if (buildSegment !== undefined) {
    const buildMatch = BUILD_SEGMENT_PATTERN.exec(buildSegment);
    if (!buildMatch || !isToken(buildMatch[1])) return undefined;
    identity.build = buildMatch[1];
  }
  return identity;
}
