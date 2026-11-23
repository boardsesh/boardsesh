import { boardTypeLabel } from '@boardsesh/board-constants';
import type { BoardName } from '@boardsesh/shared-schema';
import manifest from './board-gallery-manifest.json';
import { getOrderedGalleryLayouts } from './board-gallery-config';

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
    return { ...image, caption: compactBoardLayoutName(boardName, layout.name) };
  });
}
