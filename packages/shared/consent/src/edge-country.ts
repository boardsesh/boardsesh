import { BlockList, isIP } from 'node:net';

/**
 * Which country a request came from, but only when Cloudflare said so.
 *
 * Node-only (`node:net`), so it ships as its own subpath,
 * `@boardsesh/consent/edge-country`, and never reaches the mobile bundle
 * through the package index.
 *
 * The backend (`packages/backend/src/utils/flag-country.ts`) and the web server
 * both read `CF-IPCountry` through these ranges. See docs/cloudflare.md,
 * "Observe country header".
 */

// https://www.cloudflare.com/ips-v4/ and /ips-v6/, checked 2026-10-08.
// An outdated list fails closed for newly introduced edge ranges.
export const CLOUDFLARE_EDGE_SUBNETS: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** A `BlockList` holding {@link CLOUDFLARE_EDGE_SUBNETS}. */
export function createCloudflareEdgeBlockList(): BlockList {
  const peers = new BlockList();
  for (const subnet of CLOUDFLARE_EDGE_SUBNETS) {
    const [address, prefix] = subnet.split('/');
    peers.addSubnet(address!, Number(prefix), isIP(address!) === 4 ? 'ipv4' : 'ipv6');
  }
  return peers;
}

/**
 * ISO 3166-1 alpha-2 country codes (249 entries, checked 2026-10-12).
 * https://www.iso.org/obp/ui/#search/code/
 * Unknown, user-assigned (including XK) and reserved codes fail closed.
 */
const KNOWN_COUNTRY_CODES: ReadonlySet<string> = new Set(
  [
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW',
    'BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI',
    'FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN',
    'IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME',
    'MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF',
    'PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV',
    'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE',
    'YT ZA ZM ZW',
  ]
    .join(' ')
    .split(' '),
);

/**
 * The country code when it names one real country, else null. Lowercase,
 * padded, Tor (`T1`), `XX` and anything else unexpected all come back null.
 */
export function normalizeCountry(countryCode: string | null | undefined): string | null {
  return typeof countryCode === 'string' && KNOWN_COUNTRY_CODES.has(countryCode) ? countryCode : null;
}

const cloudflarePeers = createCloudflareEdgeBlockList();

/** Lowercased, IPv4-mapped IPv6 unwrapped, and only when it parses as an address. */
export function normalizeIpAddress(address: string | undefined): string | undefined {
  const normalized = address
    ?.trim()
    .toLowerCase()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return normalized && isIP(normalized) ? normalized : undefined;
}

export function isCloudflareEdgeAddress(address: string | undefined): boolean {
  const normalized = normalizeIpAddress(address);
  return !!normalized && cloudflarePeers.check(normalized, isIP(normalized) === 4 ? 'ipv4' : 'ipv6');
}

export type ForwardedCountryHeaders = {
  /** The raw `X-Forwarded-For` value. */
  forwardedFor: string | null | undefined;
  /** The raw `CF-IPCountry` value. */
  country: string | null | undefined;
};

/**
 * The visitor's country from `CF-IPCountry`, or null.
 *
 * For a server that cannot see its socket peer (a Next.js server component).
 * Our hosted ingress appends the address it observed to `X-Forwarded-For`, so
 * the LAST hop is the only one a caller cannot write. The country is trusted
 * only when that hop is a Cloudflare edge: a request sent straight to the
 * origin ends in the caller's own address and reads as null, whatever
 * `CF-IPCountry` it carries. Unknown codes (`XX`, `T1`, lowercase, ...) are null
 * too.
 */
export function trustedEdgeCountry({ forwardedFor, country }: ForwardedCountryHeaders): string | null {
  const lastHop = forwardedFor?.split(',').at(-1);
  if (!isCloudflareEdgeAddress(lastHop)) return null;
  return normalizeCountry(country?.trim());
}
