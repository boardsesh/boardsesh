import { useCallback, type KeyboardEvent } from 'react';
import type { PlayerKeyboardNavigationOptions } from './use-player-keyboard-navigation.types';

const ARROW_CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="tab"]',
  '[role="tablist"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(',');
const OVERLAY_SELECTOR =
  '[data-boardsesh-player-shortcut-block="true"], [aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]';

function hidden(element: Element): boolean {
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.matches('[hidden], [inert], [aria-hidden="true"]')) return true;
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
}

function blockingOverlay(player: HTMLElement): boolean {
  return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some(
    // The full-screen player's own modal is an ancestor, not a blocker.
    (overlay) => !overlay.contains(player) && !hidden(overlay),
  );
}

/** Bubbling from this player only: keyboard focus elsewhere never changes climbs. */
export function usePlayerKeyboardNavigation({
  enabled,
  label,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  onEscape,
}: PlayerKeyboardNavigationOptions) {
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.repeat ||
        event.nativeEvent.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        hidden(event.currentTarget) ||
        blockingOverlay(event.currentTarget)
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
      if (target.closest(ARROW_CONTROL_SELECTOR)) return;
      const action =
        event.key === 'ArrowLeft' && canPrevious
          ? onPrevious
          : event.key === 'ArrowRight' && canNext
            ? onNext
            : event.key === 'Escape'
              ? onEscape
              : undefined;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    },
    [enabled, canPrevious, canNext, onPrevious, onNext, onEscape],
  );

  return { onKeyDown, tabIndex: enabled ? 0 : undefined, role: 'region' as const, 'aria-label': label };
}
