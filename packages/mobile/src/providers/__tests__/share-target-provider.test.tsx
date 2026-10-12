// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ShareReceiptState } from '../share-receipt-context';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setParams: vi.fn(),
  consumeLink: vi.fn(async () => {}),
  consumeBugNavigation: vi.fn(),
  clearNotice: vi.fn(),
  showToast: vi.fn(),
  segments: [] as string[],
  authenticated: true,
  consentSettled: true,
  launchReady: true,
}));
const receipt: ShareReceiptState = { draft: null, pendingLink: null, notice: null, revision: 0, destination: null };
vi.mock('../share-receipt-provider', () => ({
  useShareReceipt: () => ({
    ...receipt,
    consumeLink: mocks.consumeLink,
    consumeBugNavigation: mocks.consumeBugNavigation,
    clearNotice: mocks.clearNotice,
  }),
}));
vi.mock('../../lib/consent-hooks', () => ({ useConsentSettled: () => mocks.consentSettled }));
vi.mock('../launch-ready-context', () => ({ useLaunchReady: () => mocks.launchReady }));
vi.mock('../auth-provider', () => ({ useAuth: () => ({ isAuthenticated: mocks.authenticated }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mocks.navigate, setParams: mocks.setParams }),
  useSegments: () => mocks.segments,
}));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ShareTargetProvider, extractSharedLink } from '../share-target-provider';

const INSTAGRAM_LINK = 'https://instagram.com/reel/abc123';
function renderProvider() {
  return render(<ShareTargetProvider>{null}</ShareTargetProvider>);
}
function stageBug() {
  receipt.draft = {
    id: 'draft-1',
    attachments: [
      { id: 'image-1', kind: 'image', uri: 'document/shot.jpg', name: 'shot.jpg', mimeType: 'image/jpeg', size: 100 },
    ],
    comment: '',
    contactConsent: true,
    uploadedKeysByUri: {},
  };
  receipt.destination = 'bug';
  receipt.revision = 1;
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(receipt, { draft: null, pendingLink: null, notice: null, revision: 0, destination: null });
  Object.assign(mocks, { segments: [], authenticated: true, consentSettled: true, launchReady: true });
});

describe('extractSharedLink', () => {
  it('prefers the structured webUrl', () => {
    expect(extractSharedLink({ webUrl: '  https://instagram.com/reel/x  ', text: 'ignored' })).toBe(
      'https://instagram.com/reel/x',
    );
  });

  it('pulls the first URL out of caption text when there is no webUrl', () => {
    expect(extractSharedLink({ webUrl: null, text: 'nice send https://instagram.com/reel/y 🔥' })).toBe(
      'https://instagram.com/reel/y',
    );
  });

  it('falls back from an empty webUrl to a URL in the text', () => {
    expect(extractSharedLink({ webUrl: '', text: 'see https://tiktok.com/@me/video/1' })).toBe(
      'https://tiktok.com/@me/video/1',
    );
  });

  it('strips an emoji glued directly onto the URL', () => {
    expect(extractSharedLink({ webUrl: null, text: 'crushed it https://www.instagram.com/reel/abc123🔥' })).toBe(
      'https://www.instagram.com/reel/abc123',
    );
  });

  it('strips wrapping brackets and trailing sentence punctuation', () => {
    expect(extractSharedLink({ webUrl: null, text: '(https://www.instagram.com/reel/abc123).' })).toBe(
      'https://www.instagram.com/reel/abc123',
    );
  });

  it('preserves a canonical trailing slash', () => {
    expect(extractSharedLink({ webUrl: null, text: 'see https://www.instagram.com/reel/abc123/ now' })).toBe(
      'https://www.instagram.com/reel/abc123/',
    );
  });

  it('returns null when there is no URL', () => {
    expect(extractSharedLink({ webUrl: null, text: 'just words' })).toBeNull();
    expect(extractSharedLink(null)).toBeNull();
  });
});

describe('ShareTargetProvider durable navigation', () => {
  it('opens a beta link and consumes it after navigation', async () => {
    Object.assign(receipt, { pendingLink: INSTAGRAM_LINK, destination: 'beta' });
    renderProvider();
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({ pathname: '/share-beta', params: { link: INSTAGRAM_LINK } }),
    );
    expect(mocks.consumeLink).toHaveBeenCalledWith(INSTAGRAM_LINK);
  });
  it('reuses an already-open beta modal', async () => {
    Object.assign(receipt, { pendingLink: INSTAGRAM_LINK, destination: 'beta' });
    mocks.segments = ['share-beta'];
    renderProvider();
    await waitFor(() => expect(mocks.setParams).toHaveBeenCalledWith({ link: INSTAGRAM_LINK }));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('keeps media pending through login, consent and launch readiness', async () => {
    stageBug();
    mocks.authenticated = false;
    const view = renderProvider();
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.authenticated = true;
    mocks.consentSettled = false;
    view.rerender(<ShareTargetProvider>{null}</ShareTargetProvider>);
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.consentSettled = true;
    mocks.launchReady = false;
    view.rerender(<ShareTargetProvider>{null}</ShareTargetProvider>);
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.launchReady = true;
    view.rerender(<ShareTargetProvider>{null}</ShareTargetProvider>);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({ pathname: '/share-bug', params: { draftId: 'draft-1' } }),
    );
    expect(mocks.consumeBugNavigation).toHaveBeenCalledTimes(1);
  });
  it('does not consume a signed-out beta share', () => {
    Object.assign(receipt, { pendingLink: INSTAGRAM_LINK, destination: 'beta' });
    mocks.authenticated = false;
    renderProvider();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.consumeLink).not.toHaveBeenCalled();
  });
  it('reuses the bug modal for successive media shares', async () => {
    stageBug();
    mocks.segments = ['share-bug'];
    renderProvider();
    await waitFor(() => expect(mocks.setParams).toHaveBeenCalledWith({ draftId: 'draft-1' }));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('does not reopen a report when its description changes', async () => {
    stageBug();
    const view = renderProvider();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    receipt.draft = { ...receipt.draft!, comment: 'The queue is stuck' };
    view.rerender(<ShareTargetProvider>{null}</ShareTargetProvider>);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
  it('shows invalid-link feedback when no report modal owns it', () => {
    receipt.notice = 'invalidLink';
    renderProvider();
    expect(mocks.showToast).toHaveBeenCalledWith('mobile.betaVideos.urlInvalid', 'error');
    expect(mocks.clearNotice).toHaveBeenCalled();
  });
  it('leaves media receipt errors for inline display in the report', () => {
    stageBug();
    receipt.notice = 'overflow';
    renderProvider();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(mocks.clearNotice).not.toHaveBeenCalled();
  });
});
