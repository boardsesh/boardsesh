const IPV6_PREFIX_HEXTETS = 4;
const IPV6_TOTAL_HEXTETS = 8;

function parseIpv4(address: string): number[] | undefined {
  const octetStrings = address.split('.');
  if (octetStrings.length !== 4 || octetStrings.some((octet) => !/^(?:0|[1-9]\d{0,2})$/.test(octet))) {
    return undefined;
  }
  const octets = octetStrings.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

function expandIpv6Hextets(address: string): string[] | undefined {
  const runSplit = address.split('::');
  if (runSplit.length > 2) return undefined;

  const splitGroups = (addressPart: string): string[] => (addressPart ? addressPart.split(':') : []);
  const expandTrailingIpv4 = (groups: string[]): string[] | undefined => {
    const lastGroup = groups.at(-1);
    if (!lastGroup?.includes('.')) return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups : undefined;
    const octets = parseIpv4(lastGroup);
    if (!octets || !groups.slice(0, -1).every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return [
      ...groups.slice(0, -1),
      (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16),
      (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16),
    ];
  };

  const leadingGroups = splitGroups(runSplit[0] ?? '');
  // A dotted IPv4 tail is legal only at the very end of an IPv6 literal. If
  // `::` follows it, it is in the leading side and therefore cannot be the
  // final 32 bits.
  const leadingHextets =
    runSplit.length === 1
      ? expandTrailingIpv4(leadingGroups)
      : leadingGroups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
        ? leadingGroups
        : undefined;
  if (!leadingHextets) return undefined;
  if (runSplit.length === 1) {
    return leadingHextets.length === IPV6_TOTAL_HEXTETS ? leadingHextets : undefined;
  }

  const trailingHextets = expandTrailingIpv4(splitGroups(runSplit[1] ?? ''));
  if (!trailingHextets) return undefined;
  const zeroRunLength = IPV6_TOTAL_HEXTETS - leadingHextets.length - trailingHextets.length;
  if (zeroRunLength < 1) return undefined;
  return [...leadingHextets, ...Array<string>(zeroRunLength).fill('0'), ...trailingHextets];
}

/** Normalize an IP for stable rate-limit keys, including IPv6 /64 grouping. */
export function normalizeRateLimitIp(rawAddress: string | undefined): string | undefined {
  const trimmedAddress = rawAddress?.trim();
  if (!trimmedAddress) return undefined;

  const hasOpeningBracket = trimmedAddress.startsWith('[');
  const hasClosingBracket = trimmedAddress.endsWith(']');
  if (hasOpeningBracket !== hasClosingBracket) return undefined;

  const withoutBrackets = hasOpeningBracket ? trimmedAddress.slice(1, -1) : trimmedAddress;
  if (withoutBrackets.includes('[') || withoutBrackets.includes(']')) return undefined;

  const zoneParts = withoutBrackets.split('%');
  if (zoneParts.length > 2) return undefined;
  const withoutZone = zoneParts[0] ?? '';
  const zoneIdentifier = zoneParts[1];
  if (zoneIdentifier !== undefined) {
    // Zone identifiers belong to IPv6 scope IDs. Keep accepting the socket
    // forms used by the backend, including bracketed forms, but never turn an
    // IPv4 value with a forged suffix into a valid identity.
    if (!withoutZone.includes(':') || !zoneIdentifier || /\s/.test(zoneIdentifier)) return undefined;
  }
  const lowercasedAddress = withoutZone.toLowerCase();
  const mappedIpv4Tail = lowercasedAddress.startsWith('::ffff:')
    ? lowercasedAddress.slice('::ffff:'.length)
    : undefined;
  const mappedIpv4Octets = mappedIpv4Tail ? parseIpv4(mappedIpv4Tail) : undefined;
  const normalizedAddress = mappedIpv4Octets ? mappedIpv4Octets.join('.') : lowercasedAddress;

  const ipv4Octets = parseIpv4(normalizedAddress);
  if (ipv4Octets) return ipv4Octets.join('.');

  const hextets = expandIpv6Hextets(normalizedAddress);
  if (!hextets) return undefined;
  const prefix = hextets
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((hextet) => hextet.replace(/^0+(?=.)/, ''))
    .join(':');
  return `${prefix}::/64`;
}
