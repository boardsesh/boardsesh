const INSTAGRAM_URL_REGEX = /^https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|tv)\/([\w-]+)(?:[/?#]|$)/i;

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const INSTAGRAM_FETCH_HEADERS = {
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

const GENERIC_VALIDATION_ERROR =
  "We couldn't verify this Instagram link. Make sure it's a public post or reel that Boardsesh can preview, and that the caption or title mentions the climb name.";

export class InstagramBetaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstagramBetaValidationError';
  }
}

export interface InstagramPageMetadata {
  description: string | null;
  imageUrl: string | null;
  mediaId: string | null;
  ogTitle: string | null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (_, entity) => HTML_ENTITY_MAP[entity.toLowerCase()] ?? `&${entity};`);
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsNormalizedClimbName(haystack: string, climbName: string): boolean {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedClimbName = normalizeText(climbName);

  if (!normalizedHaystack || !normalizedClimbName) return false;
  if (normalizedHaystack.includes(normalizedClimbName)) return true;

  const tokens = normalizedClimbName.split(' ').filter(Boolean);
  if (tokens.length === 0) return false;

  let cursor = 0;
  for (const token of tokens) {
    const nextIndex = normalizedHaystack.indexOf(token, cursor);
    if (nextIndex === -1) return false;
    cursor = nextIndex + token.length;
  }
  return true;
}

function parseMetaContent(html: string, target: string): string | null {
  const metaTagRegex = /<meta\b[^>]*>/gi;
  const attrRegex = /([a-zA-Z_:.-]+)\s*=\s*"([^"]*)"/g;
  const normalizedTarget = target.toLowerCase();

  for (const metaTag of html.match(metaTagRegex) ?? []) {
    const attrs: Record<string, string> = {};
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(metaTag)) !== null) {
      attrs[match[1].toLowerCase()] = match[2];
    }

    if (attrs.property?.toLowerCase() === normalizedTarget || attrs.name?.toLowerCase() === normalizedTarget) {
      return attrs.content ? decodeHtmlEntities(attrs.content) : null;
    }
  }

  return null;
}

export function parseInstagramMediaId(url: string): string | null {
  return url.match(INSTAGRAM_URL_REGEX)?.[1] ?? null;
}

export async function fetchInstagramPageMetadata(url: string): Promise<InstagramPageMetadata> {
  const response = await fetch(url, {
    headers: INSTAGRAM_FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new InstagramBetaValidationError(GENERIC_VALIDATION_ERROR);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new InstagramBetaValidationError(GENERIC_VALIDATION_ERROR);
  }

  const html = await response.text();
  const description = parseMetaContent(html, 'description') ?? parseMetaContent(html, 'og:description');
  const ogTitle = parseMetaContent(html, 'og:title') ?? parseMetaContent(html, 'twitter:title');
  const imageUrl = parseMetaContent(html, 'og:image') ?? parseMetaContent(html, 'twitter:image');
  const mediaIdFromAppUrl = parseMetaContent(html, 'al:ios:url')?.match(/instagram:\/\/media\?id=(\d+)/)?.[1] ?? null;

  if (!description && !ogTitle) {
    throw new InstagramBetaValidationError(GENERIC_VALIDATION_ERROR);
  }

  return {
    description,
    imageUrl,
    mediaId: mediaIdFromAppUrl ?? parseInstagramMediaId(url),
    ogTitle,
  };
}

export async function validateInstagramBetaLink(url: string, climbName: string): Promise<InstagramPageMetadata> {
  const metadata = await fetchInstagramPageMetadata(url);

  if (!metadata.imageUrl || !metadata.mediaId) {
    throw new InstagramBetaValidationError(GENERIC_VALIDATION_ERROR);
  }

  const searchableText = [metadata.ogTitle, metadata.description].filter(Boolean).join(' ');
  if (!containsNormalizedClimbName(searchableText, climbName)) {
    throw new InstagramBetaValidationError(
      `We couldn't confirm this video is for "${climbName}". Please use a public Instagram post or reel whose caption or title mentions the climb name.`,
    );
  }

  return metadata;
}

export const instagramBetaValidationInternals = {
  containsNormalizedClimbName,
  decodeHtmlEntities,
  normalizeText,
  parseInstagramMediaId,
  parseMetaContent,
};
