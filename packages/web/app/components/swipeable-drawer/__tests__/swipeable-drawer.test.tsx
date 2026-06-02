import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

import SwipeableDrawer from '../swipeable-drawer';
import styles from '../swipeable-drawer.module.css';

// We render the drawer with disablePortal so jsdom can find its contents
// without needing a full MUI portal setup.
const baseProps = {
  open: true,
  disablePortal: true,
  onClose: vi.fn(),
};

// The MUI SwipeableDrawer root gets the className from the `className` prop on
// <MuiSwipeableDrawer>. Our component maps its `rootClassName` / `className`
// props onto that. Locate the root by the MUI class that MUI always applies.
function getMuiDrawerRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.MuiDrawer-root');
}

describe('SwipeableDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('close button rendering', () => {
    it('renders the close button by default (showCloseButton undefined)', () => {
      render(
        <SwipeableDrawer {...baseProps} placement="bottom">
          <div>body</div>
        </SwipeableDrawer>,
      );
      expect(document.querySelector('.drawer-close-btn')).not.toBeNull();
    });

    it('does not render the close button when showCloseButton is false', () => {
      render(
        <SwipeableDrawer {...baseProps} placement="bottom" showCloseButton={false}>
          <div>body</div>
        </SwipeableDrawer>,
      );
      expect(document.querySelector('.drawer-close-btn')).toBeNull();
    });

    it('calls onClose when the close button is clicked', () => {
      const onClose = vi.fn();
      render(
        <SwipeableDrawer {...baseProps} placement="bottom" onClose={onClose}>
          <div>body</div>
        </SwipeableDrawer>,
      );
      const btn = document.querySelector('.drawer-close-btn') as HTMLElement;
      fireEvent.click(btn);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('top placement close button position', () => {
    it('positions the close button at top-right for placement="top"', () => {
      render(
        <SwipeableDrawer {...baseProps} placement="top">
          <div>body</div>
        </SwipeableDrawer>,
      );
      const btn = document.querySelector('.drawer-close-btn') as HTMLElement;
      expect(btn).not.toBeNull();
      // MUI's sx prop is compiled to emotion classes (not inline styles),
      // which jsdom parses from the injected <style> tags.
      const computed = window.getComputedStyle(btn);
      expect(computed.top).toBe('8px');
      expect(computed.right).toBe('8px');
      // The other two sides should not be pinned (left/bottom are unset).
      expect(computed.left).not.toBe('8px');
      expect(computed.bottom).not.toBe('8px');
    });

    it('positions the close button at top-left for placement="bottom"', () => {
      render(
        <SwipeableDrawer {...baseProps} placement="bottom">
          <div>body</div>
        </SwipeableDrawer>,
      );
      const btn = document.querySelector('.drawer-close-btn') as HTMLElement;
      const computed = window.getComputedStyle(btn);
      expect(computed.top).toBe('8px');
      expect(computed.left).toBe('8px');
      expect(computed.right).not.toBe('8px');
      expect(computed.bottom).not.toBe('8px');
    });
  });

  describe('mobileHideClose class toggling', () => {
    it('adds the mobileHideClose class by default so the close button is hidden on mobile', () => {
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="top">
          <div>body</div>
        </SwipeableDrawer>,
      );
      const root = getMuiDrawerRoot(container);
      expect(root).not.toBeNull();
      expect(root?.className).toContain(styles.mobileHideClose);
    });

    it('omits the mobileHideClose class when showCloseButtonOnMobile is true', () => {
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="top" showCloseButtonOnMobile>
          <div>body</div>
        </SwipeableDrawer>,
      );
      const root = getMuiDrawerRoot(container);
      expect(root).not.toBeNull();
      expect(root?.className ?? '').not.toContain(styles.mobileHideClose);
    });

    it('preserves user-supplied className/rootClassName when showCloseButtonOnMobile is true', () => {
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="top" showCloseButtonOnMobile className="custom-class">
          <div>body</div>
        </SwipeableDrawer>,
      );
      const root = getMuiDrawerRoot(container);
      expect(root?.className).toContain('custom-class');
      expect(root?.className ?? '').not.toContain(styles.mobileHideClose);
    });

    it('merges mobileHideClose with user-supplied className by default', () => {
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="top" className="custom-class">
          <div>body</div>
        </SwipeableDrawer>,
      );
      const root = getMuiDrawerRoot(container);
      expect(root?.className).toContain('custom-class');
      expect(root?.className).toContain(styles.mobileHideClose);
    });
  });

  describe('title', () => {
    it('renders the title when provided', () => {
      render(
        <SwipeableDrawer {...baseProps} placement="top" title="My title">
          <div>body</div>
        </SwipeableDrawer>,
      );
      expect(screen.getByText('My title')).toBeTruthy();
    });
  });

  describe('swipe blocking', () => {
    // MUI's handleBodyTouchStart bails out when nativeEvent.defaultMuiPrevented
    // is true (SwipeableDrawer.js:398), but also sets the flag itself when the
    // drawer is open and the touch is inside the paper (line 426). To isolate
    // what OUR handler did, we observe the flag from a bubble-phase listener
    // on document.body — React's delegated listener on the root container
    // dispatches synthetic handlers during bubble phase before the event
    // reaches document.body, while MUI's listener is on document (one step
    // later in the bubble chain).
    function dispatchAndReadFlagPostReact(target: HTMLElement): boolean {
      let flag = false;
      const read = (e: Event) => {
        flag = Boolean((e as unknown as Record<string, unknown>).defaultMuiPrevented);
      };
      document.body.addEventListener('touchstart', read);
      const event = new Event('touchstart', { bubbles: true, cancelable: true });
      // jsdom lacks a TouchEvent constructor; stub `touches` so MUI's
      // calculateCurrentX/Y don't throw when its document listener fires.
      Object.defineProperty(event, 'touches', {
        value: [{ pageX: 0, pageY: 0, clientX: 0, clientY: 0 }],
      });
      try {
        target.dispatchEvent(event);
      } finally {
        document.body.removeEventListener('touchstart', read);
      }
      return flag;
    }

    it('sets defaultMuiPrevented when touchstart originates inside a [data-swipe-blocked] zone', () => {
      // Override disablePortal: the nested-drawer branch otherwise sets the
      // flag unconditionally, which would hide whether the zone check ran.
      render(
        <SwipeableDrawer {...baseProps} disablePortal={false} placement="bottom">
          <div data-swipe-blocked="true">
            <div data-testid="inner">map content</div>
          </div>
        </SwipeableDrawer>,
      );

      expect(dispatchAndReadFlagPostReact(screen.getByTestId('inner'))).toBe(true);
    });

    it('does not set defaultMuiPrevented when touchstart target has no [data-swipe-blocked] ancestor', () => {
      // The target still sits inside the drawer paper; what matters is that
      // no ancestor in its chain carries the swipe-blocked attribute, so our
      // handler should not claim the touch. (MUI's own document listener
      // will set the flag later — our helper reads it at document.body,
      // before that listener runs.) The assertion is Boolean-coerced in the
      // helper, so "unset" (undefined) and "explicit false" both satisfy it —
      // we only care that our handler didn't set it to a truthy value.
      render(
        <SwipeableDrawer {...baseProps} disablePortal={false} placement="bottom">
          <div data-testid="unblocked">regular content</div>
        </SwipeableDrawer>,
      );

      expect(dispatchAndReadFlagPostReact(screen.getByTestId('unblocked'))).toBe(false);
    });

    it('sets defaultMuiPrevented on any touch when disablePortal is set (nested-drawer case)', () => {
      render(
        <SwipeableDrawer {...baseProps} placement="bottom">
          <div data-testid="anywhere">regular content</div>
        </SwipeableDrawer>,
      );

      // baseProps.disablePortal is true → handler sets flag regardless of zone.
      expect(dispatchAndReadFlagPostReact(screen.getByTestId('anywhere'))).toBe(true);
    });

    it('does not set defaultMuiPrevented when open=false (handler early-returns)', () => {
      // Even with both conditions that would otherwise trigger the flag
      // (disablePortal + a [data-swipe-blocked] ancestor), the handler's
      // first line bails out when the drawer is closed, so neither branch
      // runs. keepMounted keeps the inner Box in the DOM so we can dispatch
      // a touchstart against it.
      render(
        <SwipeableDrawer {...baseProps} open={false} keepMounted placement="bottom">
          <div data-swipe-blocked="true">
            <div data-testid="closed-inner">content while closed</div>
          </div>
        </SwipeableDrawer>,
      );

      expect(dispatchAndReadFlagPostReact(screen.getByTestId('closed-inner'))).toBe(false);
    });

    // Partial regression coverage for #1621: a full pan-north swipe inside a
    // [data-swipe-blocked] zone must not close the drawer. jsdom has no
    // TouchEvent constructor, so we can't dispatch a touchmove/touchend
    // sequence here — instead we verify the upstream guard that gates the
    // whole flow. Our handler sets defaultMuiPrevented on touchstart, which
    // makes MUI's handleBodyTouchStart return early (SwipeableDrawer.js:398-400)
    // without calling startMaybeSwiping, so no subsequent touchend would reach
    // onClose either. This asserts only the synchronous touchstart → onClose
    // path; end-to-end swipe-gesture coverage lives in the Playwright suite.
    it('(#1621, partial) touchstart in a [data-swipe-blocked] zone does not synchronously call onClose — full gesture not simulable in jsdom', () => {
      const onClose = vi.fn();
      render(
        <SwipeableDrawer {...baseProps} disablePortal={false} placement="bottom" onClose={onClose}>
          <div data-swipe-blocked="true">
            <div data-testid="inner">map content</div>
          </div>
        </SwipeableDrawer>,
      );

      const event = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', {
        value: [{ pageX: 0, pageY: 0, clientX: 0, clientY: 0 }],
      });
      screen.getByTestId('inner').dispatchEvent(event);

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  // handleSwipeableClose is MUI's onClose (fired on backdrop click / Esc / swipe
  // release). jsdom can't dispatch a real swipe-gesture sequence, so we trigger
  // it via a backdrop click and prime the paper's inline transform to exercise
  // the synchronous branches the e2e can't isolate.
  describe('swipe-close handoff (handleSwipeableClose)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // The paper element handleSwipeableClose mutates is the one captured in
    // lastPaperRef — the wrapper Box's parent — which is `.MuiDrawer-paper`.
    function getPaper(): HTMLElement {
      return document.querySelector('.MuiDrawer-paper') as HTMLElement;
    }
    function triggerClose(container: HTMLElement) {
      // MUI Modal invokes onClose on a backdrop click.
      fireEvent.click(container.querySelector('.MuiBackdrop-root') as HTMLElement);
    }
    function dispatchTransformEnd(paper: HTMLElement) {
      const event = new Event('transitionend') as TransitionEvent;
      Object.defineProperty(event, 'propertyName', { value: 'transform' });
      paper.dispatchEvent(event);
    }

    it('closes synchronously when the paper carries no gesture transform', () => {
      // No in-progress swipe → no inline transform → close immediately (the
      // backdrop / Esc / programmatic path), bypassing the gesture animation.
      const onClose = vi.fn();
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="bottom" onClose={onClose} keepMounted>
          <div>body</div>
        </SwipeableDrawer>,
      );
      getPaper().style.transform = '';
      triggerClose(container);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('defers onClose until the close transition ends when a swipe pre-positioned the paper', () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="bottom" onClose={onClose} keepMounted>
          <div>body</div>
        </SwipeableDrawer>,
      );
      const paper = getPaper();
      Object.defineProperty(paper, 'offsetHeight', { value: 1000, configurable: true });
      paper.style.transform = 'translateY(600px)'; // gesture pulled it past the half-way gate

      triggerClose(container);
      // The wrapper animates the paper the rest of the way off-screen first.
      expect(onClose).not.toHaveBeenCalled();
      expect(paper.style.transform).toBe('translateY(1000px)');

      act(() => dispatchTransformEnd(paper));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('falls back to a timer when transitionend never fires', () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      const { container } = render(
        <SwipeableDrawer {...baseProps} placement="bottom" onClose={onClose} keepMounted>
          <div>body</div>
        </SwipeableDrawer>,
      );
      const paper = getPaper();
      Object.defineProperty(paper, 'offsetHeight', { value: 1000, configurable: true });
      paper.style.transform = 'translateY(600px)';

      triggerClose(container);
      expect(onClose).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(400); // > duration + fallback margin
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('cancels the deferred onClose when the drawer unmounts mid-close', () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      const { container, unmount } = render(
        <SwipeableDrawer {...baseProps} placement="bottom" onClose={onClose} keepMounted>
          <div>body</div>
        </SwipeableDrawer>,
      );
      const paper = getPaper();
      Object.defineProperty(paper, 'offsetHeight', { value: 1000, configurable: true });
      paper.style.transform = 'translateY(600px)';

      triggerClose(container);
      expect(onClose).not.toHaveBeenCalled();

      unmount();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      dispatchTransformEnd(paper);
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
