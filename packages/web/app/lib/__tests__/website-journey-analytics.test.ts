// @vitest-environment jsdom
import type { MouseEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { webAppOpened } from '@boardsesh/analytics';
import { track, trackBeforeNavigation } from '../analytics';
import { trackWebsiteJourneyEvent, trackWebsiteJourneyLinkClick } from '../website-journey-analytics';

vi.mock('../analytics', () => ({ track: vi.fn(), trackBeforeNavigation: vi.fn() }));

const navigate = vi.fn();
function linkClick(modifiers: Partial<MouseEvent<HTMLAnchorElement>> = {}, target = '') {
  const anchor = document.createElement('a');
  anchor.href = 'https://app.boardsesh.com/';
  anchor.target = target;
  const click = {
    currentTarget: anchor,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as MouseEvent<HTMLAnchorElement> & { preventDefault: ReturnType<typeof vi.fn> };
  return click;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    location: { origin: 'https://www.boardsesh.com', pathname: '/help', search: '', assign: navigate },
  });
  vi.mocked(trackBeforeNavigation).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

const payload = webAppOpened('header');

describe('website journey tracking', () => {
  it('delegates every event to the existing consent-gated tracker', () => {
    trackWebsiteJourneyEvent(payload);
    expect(track).toHaveBeenCalledWith('Web App Opened', { placement: 'header' });
  });

  it('flushes before replacing the current document', async () => {
    let finishFlush: (() => void) | undefined;
    vi.mocked(trackBeforeNavigation).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve;
        }),
    );
    const click = linkClick();
    trackWebsiteJourneyLinkClick(click, payload);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(trackBeforeNavigation).toHaveBeenCalledWith('Web App Opened', { placement: 'header' });
    expect(navigate).not.toHaveBeenCalled();
    finishFlush?.();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://app.boardsesh.com/');
  });

  it('still opens the destination when flushing fails', async () => {
    vi.mocked(trackBeforeNavigation).mockRejectedValue(new Error('offline'));
    trackWebsiteJourneyLinkClick(linkClick(), payload);
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://app.boardsesh.com/');
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    'keeps modified browser clicks intact: %j',
    (modifiers) => {
      const click = linkClick(modifiers);
      trackWebsiteJourneyLinkClick(click, payload);
      expect(click.preventDefault).not.toHaveBeenCalled();
      expect(trackBeforeNavigation).not.toHaveBeenCalled();
      expect(track).toHaveBeenCalledWith(payload.name, payload.properties);
    },
  );

  it('keeps a new-tab link intact', () => {
    const click = linkClick({}, '_blank');
    trackWebsiteJourneyLinkClick(click, payload);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(trackBeforeNavigation).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(payload.name, payload.properties);
  });

  it('keeps same-origin router navigation intact', () => {
    const click = linkClick();
    click.currentTarget.href = 'https://www.boardsesh.com/help';
    trackWebsiteJourneyLinkClick(click, payload);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(payload.name, payload.properties);
  });

  it.each(['mailto:support@auroraclimbing.com', 'tel:+31201234567'])(
    'keeps external-protocol links inside the trusted browser click: %s',
    (destination) => {
      const click = linkClick();
      click.currentTarget.href = destination;
      trackWebsiteJourneyLinkClick(click, payload);
      expect(click.preventDefault).not.toHaveBeenCalled();
      expect(trackBeforeNavigation).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(track).toHaveBeenCalledWith(payload.name, payload.properties);
    },
  );

  it('does not report an action another handler already canceled', () => {
    trackWebsiteJourneyLinkClick(linkClick({ defaultPrevented: true }), payload);
    expect(track).not.toHaveBeenCalled();
    expect(trackBeforeNavigation).not.toHaveBeenCalled();
  });
});
