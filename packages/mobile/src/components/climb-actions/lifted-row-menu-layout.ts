export type MenuAnchorRect = { x: number; y: number; width: number; height: number };
export type MenuViewport = { width: number; height: number };
export type MenuInsets = { top: number; bottom: number; left: number; right: number };

export type LiftedRowMenuLayout = {
  preview: { left: number; top: number; width: number; height: number };
  menu: { left: number; top: number; width: number; maxHeight: number };
};

type LiftedRowMenuLayoutInput = {
  anchor: MenuAnchorRect;
  viewport: MenuViewport;
  insets: MenuInsets;
  /** Measured content height, or an estimate until the menu has laid out. */
  menuHeight: number;
  menuWidth?: number;
};

const SIDE_GUTTER = 16;
const VERTICAL_GUTTER = 8;
const PREVIEW_MENU_GAP = 10;
const DEFAULT_MENU_WIDTH = 280;
const MINIMUM_MENU_TARGET_HEIGHT = 44;

const finiteSize = (dimension: number): number => (Number.isFinite(dimension) ? Math.max(0, dimension) : 0);
const clamp = (position: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(position, minimum), maximum);

/**
 * Place the source row and its actions as one group, independent of the trigger.
 * Tall menus scroll; an unusually tall source preview leaves one action target
 * visible and must be clipped by its host to the returned preview height.
 */
export function getLiftedRowMenuLayout({
  anchor,
  viewport,
  insets,
  menuHeight,
  menuWidth = DEFAULT_MENU_WIDTH,
}: LiftedRowMenuLayoutInput): LiftedRowMenuLayout {
  const viewportWidth = finiteSize(viewport.width);
  const viewportHeight = finiteSize(viewport.height);
  const leftInset = Math.min(finiteSize(insets.left), viewportWidth);
  const rightInset = Math.min(finiteSize(insets.right), viewportWidth - leftInset);
  const topInset = Math.min(finiteSize(insets.top), viewportHeight);
  const bottomInset = Math.min(finiteSize(insets.bottom), viewportHeight - topInset);
  const horizontalGutter = Math.min(SIDE_GUTTER, (viewportWidth - leftInset - rightInset) / 2);
  const verticalGutter = Math.min(VERTICAL_GUTTER, (viewportHeight - topInset - bottomInset) / 2);
  const left = leftInset + horizontalGutter;
  const right = viewportWidth - rightInset - horizontalGutter;
  const top = topInset + verticalGutter;
  const bottom = viewportHeight - bottomInset - verticalGutter;
  const availableWidth = Math.max(0, right - left);
  const availableHeight = Math.max(0, bottom - top);

  const previewWidth = Math.min(finiteSize(anchor.width), availableWidth);
  const sourceHeight = previewWidth > 0 ? finiteSize(anchor.height) : 0;
  const requestedMenuHeight = finiteSize(menuHeight);
  const minimumMenuHeight = Math.min(MINIMUM_MENU_TARGET_HEIGHT, requestedMenuHeight, availableHeight);
  const reservedGap =
    sourceHeight > 0 && requestedMenuHeight > 0
      ? Math.min(PREVIEW_MENU_GAP, Math.max(0, availableHeight - minimumMenuHeight))
      : 0;
  const previewHeight = Math.min(sourceHeight, Math.max(0, availableHeight - minimumMenuHeight - reservedGap));
  const gap = previewHeight > 0 ? reservedGap : 0;
  const maxMenuHeight = Math.min(requestedMenuHeight, Math.max(0, availableHeight - previewHeight - gap));
  const groupHeight = previewHeight + gap + maxMenuHeight;
  const previewLeft = clamp(Number.isFinite(anchor.x) ? anchor.x : left, left, right - previewWidth);
  const previewTop = clamp(Number.isFinite(anchor.y) ? anchor.y : top, top, bottom - groupHeight);
  const requestedMenuWidth = Number.isFinite(menuWidth) && menuWidth > 0 ? menuWidth : DEFAULT_MENU_WIDTH;
  const boundedMenuWidth = Math.min(requestedMenuWidth, availableWidth);

  return {
    preview: { left: previewLeft, top: previewTop, width: previewWidth, height: previewHeight },
    menu: {
      left: clamp(previewLeft, left, right - boundedMenuWidth),
      top: previewTop + previewHeight + gap,
      width: boundedMenuWidth,
      maxHeight: maxMenuHeight,
    },
  };
}
