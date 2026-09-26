import { getMoonBoardGeometryByFolder } from '@boardsesh/board-config';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';

/** Convert a raw image filename to its WebP equivalent, optionally as a thumbnail. */
export function toWebpPath(dir: string, filename: string, isThumbnail: boolean): string {
  const webpName = filename.replace(/\.png$/, '.webp');
  if (isThumbnail) {
    const lastSlash = webpName.lastIndexOf('/');
    if (lastSlash >= 0) {
      return `${dir}/${webpName.substring(0, lastSlash)}/thumbs${webpName.substring(lastSlash)}`;
    }
    return `${dir}/thumbs/${webpName}`;
  }
  return `${dir}/${webpName}`;
}

/** Which art a render should composite. Only boards that ship a dark sibling differ. */
export type BoardArtColorScheme = 'light' | 'dark';

/** Suffix marking a dark-mode art sibling, written by the scripts/generate-*-dark-art.ts pair. */
const DARK_ART_SUFFIX = '.dark.webp';

/** `foo.webp` -> `foo.dark.webp`. */
export function toDarkArtPath(webpPath: string): string {
  return webpPath.replace(/\.webp$/, DARK_ART_SUFFIX);
}

/**
 * Resolve one background layer, falling back to the light file when a dark path was asked
 * for but that board ships no dark sibling.
 *
 * Dark art is per-board and optional — Woods has it, Kilter and Tension do not — so without
 * this a dark render of an untreated board would silently drop its layers and come back as
 * an overlay on nothing.
 */
export function resolveArtPath(relPath: string, resolveImagePath: (path: string) => string | null): string | null {
  const resolved = resolveImagePath(relPath);
  if (resolved !== null) return resolved;
  if (!relPath.endsWith(DARK_ART_SUFFIX)) return null;
  return resolveImagePath(`${relPath.slice(0, -DARK_ART_SUFFIX.length)}.webp`);
}

type BoardDetailsForBg = {
  board_name: string;
  images_to_holds: Record<string, unknown>;
  layoutFolder?: string;
  holdSetImages?: string[];
};

/**
 * Build the ordered list of public/-relative paths for background images.
 * Kilter/Tension use images_to_holds keys; MoonBoard uses layoutFolder +
 * holdSetImages.
 *
 * `colorScheme: 'dark'` swings every path to its `.dark.webp` sibling. Callers pass the
 * result straight into their cache keys, so light and dark renders of the same board key
 * apart for free; `resolveArtPath` is what makes a board with no dark art still render.
 */
export function getBackgroundRelPaths(
  boardDetails: BoardDetailsForBg,
  isThumbnail: boolean,
  colorScheme: BoardArtColorScheme = 'light',
): string[] {
  const paths: string[] = [];
  const imageKeys = Object.keys(boardDetails.images_to_holds);

  if (imageKeys.length > 0) {
    // Aurora boards (Kilter, Tension): keys like "product_sizes_layouts_sets/36-1.png"
    for (const key of imageKeys) {
      paths.push(toWebpPath(`images/${boardDetails.board_name}`, key, isThumbnail));
    }
  } else if (boardDetails.layoutFolder && boardDetails.holdSetImages) {
    // MoonBoard fallback (getMoonBoardDetails normally populates images_to_holds,
    // so this runs only if a caller passes an empty map). Mini boards use their
    // own background, so resolve it from the layout's geometry.
    const bgFile = getMoonBoardGeometryByFolder(boardDetails.layoutFolder).backgroundImage;
    paths.push(toWebpPath('images/moonboard', bgFile, isThumbnail));
    for (const holdSetImage of boardDetails.holdSetImages) {
      paths.push(toWebpPath(`images/moonboard/${boardDetails.layoutFolder}`, holdSetImage, isThumbnail));
    }
  }

  return colorScheme === 'dark' ? paths.map(toDarkArtPath) : paths;
}

/** Where the board art sits on the OG canvas, in canvas pixels. */
export type OgBoardRect = { left: number; top: number; width: number; height: number };

/**
 * Build the OG social-card backdrop: a gradient canvas, a soft spotlight behind
 * the board, blurred accent circles, a rounded frame around the board art and a
 * rule separating it from the climb-identity column.
 *
 * Carries no `<text>` on purpose. The backdrop is a pure function of the board
 * rect, which is a pure function of the board config, which is what lets the
 * composited result be cached once per board and reused by every climb on it —
 * a per-climb string in here would make that cache per-climb.
 *
 * Returns an SVG buffer sharp can rasterise.
 */
export function createOgBackgroundBuffer(board: OgBoardRect): Buffer {
  const frameX = Math.max(board.left - 14, 12);
  const frameY = Math.max(board.top - 14, 12);
  const frameWidth = Math.min(board.width + 28, OG_IMAGE_WIDTH - frameX - 12);
  const frameHeight = Math.min(board.height + 28, OG_IMAGE_HEIGHT - frameY - 12);
  const spotlightX = Math.round(board.left + board.width / 2);
  const spotlightY = Math.round(board.top + board.height / 2);
  const spotlightRadius = Math.round(Math.max(board.width, board.height) * 0.75);

  return Buffer.from(
    `
      <svg width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" viewBox="0 0 ${OG_IMAGE_WIDTH} ${OG_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0E1720" />
            <stop offset="100%" stop-color="#080D13" />
          </linearGradient>
          <radialGradient id="spotlight" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.07" />
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0" />
          </radialGradient>
          <filter id="blur">
            <feGaussianBlur stdDeviation="48" />
          </filter>
        </defs>
        <rect width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" fill="url(#bg)" />
        <circle cx="200" cy="180" r="190" fill="#14B8A6" opacity="0.20" filter="url(#blur)" />
        <circle cx="1020" cy="560" r="170" fill="#F43F5E" opacity="0.12" filter="url(#blur)" />
        <circle cx="${spotlightX}" cy="${spotlightY}" r="${spotlightRadius}" fill="url(#spotlight)" />
        <rect x="24" y="24" width="${OG_IMAGE_WIDTH - 48}" height="${OG_IMAGE_HEIGHT - 48}" rx="28" fill="none" stroke="rgba(255,255,255,0.09)" />
        <rect x="${frameX}" y="${frameY}" width="${frameWidth}" height="${frameHeight}" rx="20" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.16)" />
      </svg>
    `,
  );
}
