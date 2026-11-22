/** App-owned presentation decisions. Native sheet geometry remains platform-owned. */
export type OpeningInput = 'mouse' | 'touch' | 'pen' | 'keyboard' | 'unknown';
export type SheetSurfaceSize = 'form' | 'list';
export type SheetPresentationMode = 'native' | 'sheet' | 'dialog';
export type SheetPresentationOptions = {
  surfaceSize?: SheetSurfaceSize;
  accessibilityLabel?: string;
  /** A cancellation request, distinct from the notification that dismissal finished. */
  onRequestClose?: () => void;
};

export const WEB_SHEET_REGULAR_WIDTH = 700;
export const SHEET_FORM_WIDTH = 560;
export const SHEET_LIST_WIDTH = 672;
export const WEB_TOUCH_SHEET_WIDTH = 640;
export const WEB_SHEET_GUTTER = 24;
export const WEB_DIALOG_MAX_HEIGHT = 720;

export function resolveWebSheetPresentation({
  width,
  openingInput,
}: {
  width: number;
  openingInput: OpeningInput;
}): 'sheet' | 'dialog' {
  return width >= WEB_SHEET_REGULAR_WIDTH && (openingInput === 'mouse' || openingInput === 'keyboard')
    ? 'dialog'
    : 'sheet';
}

/** Bounds adapt continuously even when an opening's presentation mode is latched. */
export function resolveSheetSurfaceBounds({
  width,
  height,
  mode,
  surfaceSize = 'form',
}: {
  width: number;
  height: number;
  mode: 'sheet' | 'dialog';
  surfaceSize?: SheetSurfaceSize;
}): { width: number; height: number } {
  const availableWidth = Math.max(0, width);
  const availableHeight = Math.max(0, height);
  if (mode === 'sheet') {
    return {
      width:
        availableWidth < WEB_SHEET_REGULAR_WIDTH
          ? availableWidth
          : Math.min(WEB_TOUCH_SHEET_WIDTH, Math.max(0, availableWidth - WEB_SHEET_GUTTER * 2)),
      height: availableHeight,
    };
  }
  return {
    width: Math.min(
      surfaceSize === 'list' ? SHEET_LIST_WIDTH : SHEET_FORM_WIDTH,
      Math.max(0, availableWidth - WEB_SHEET_GUTTER * 2),
    ),
    height: Math.min(WEB_DIALOG_MAX_HEIGHT, Math.max(0, availableHeight - WEB_SHEET_GUTTER * 2)),
  };
}
