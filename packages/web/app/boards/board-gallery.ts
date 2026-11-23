import { boardTypeLabel } from '@boardsesh/board-constants';
import type { BoardName } from '@boardsesh/shared-schema';
import { tryConstructSlugListUrl } from '@/app/lib/url-utils';
import manifest from './board-gallery-manifest.json';
import { getOrderedGalleryLayouts } from './board-gallery-config';

// Every catalog board supports a 40° climb list.
const BROWSE_ANGLE = 40;

/** The section already names the brand; retain layout generations and years. */
export function compactBoardLayoutName(boardName: string, layoutName: string): string {
  let caption = layoutName;
  if (boardName === 'moonboard') caption = caption.replace('MoonBoard ', '');
  else {
    const prefix = `${boardTypeLabel(boardName)} `;
    if (caption.startsWith(prefix)) caption = caption.slice(prefix.length);
    if (boardName === 'kilter' && caption.startsWith('Board ')) caption = caption.slice('Board '.length);
  }
  return caption.replace(/ Layout$/, '');
}

export function getBoardGalleryLayouts(boardName: Exclude<BoardName, 'spray'>) {
  return getOrderedGalleryLayouts(boardName).map((layout) => {
    const image = manifest.layouts.find((entry) => entry.boardName === boardName && entry.layoutId === layout.id);
    if (!image) throw new Error(`Regenerate board gallery art for ${boardName}/${layout.id}`);
    const browseHref = tryConstructSlugListUrl(boardName, layout.id, image.sizeId, image.setIds, BROWSE_ANGLE);
    if (!browseHref) throw new Error(`No gallery climb list for ${boardName}/${layout.id}`);
    return { ...image, caption: compactBoardLayoutName(boardName, layout.name), browseHref };
  });
}
