// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Controllable share-intent state. Mutate fields per test; the mocked hook reads
// them at call time.
const shareState: { hasShareIntent: boolean; shareIntent: { webUrl: string | null; text: string | null } } = {
  hasShareIntent: false,
  shareIntent: { webUrl: null, text: null },
};
const resetShareIntentMock = vi.fn();
vi.mock('expo-share-intent', () => ({
  useShareIntent: () => ({ ...shareState, resetShareIntent: resetShareIntentMock }),
}));

const navigateMock = vi.fn();
const setParamsMock = vi.fn();
// Current route segments the provider reads to decide navigate vs setParams.
const segmentsState: { value: string[] } = { value: [] };
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: navigateMock, setParams: setParamsMock }),
  useSegments: () => segmentsState.value,
}));

// In-memory AsyncStorage stand-in.
const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const authState = { isAuthenticated: true };
vi.mock('../auth-provider', () => ({
  useAuth: () => authState,
}));

const showToastMock = vi.fn();
vi.mock('../toast-provider', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

// Treat Instagram/TikTok URLs as valid beta links; everything else invalid.
vi.mock('@boardsesh/shared-schema', () => ({
  isBetaVideoUrl: (url: string) => /instagram\.com|tiktok\.com/.test(url),
}));

import { ShareTargetProvider, extractSharedLink } from '../share-target-provider';

const INSTAGRAM_LINK = 'https://instagram.com/reel/abc123';
const PENDING_SHARE_KEY = 'boardsesh_pending_share_link';

function renderProvider() {
  return render(<ShareTargetProvider>{null}</ShareTargetProvider>);
}

beforeEach(() => {
  navigateMock.mockReset();
  setParamsMock.mockReset();
  resetShareIntentMock.mockReset();
  showToastMock.mockReset();
  storage.clear();
  segmentsState.value = [];
  shareState.hasShareIntent = false;
  shareState.shareIntent = { webUrl: null, text: null };
  authState.isAuthenticated = true;
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

describe('ShareTargetProvider', () => {
  it('routes a shared beta link to the picker when authenticated', async () => {
    authState.isAuthenticated = true;
    shareState.hasShareIntent = true;
    shareState.shareIntent = { webUrl: INSTAGRAM_LINK, text: null };

    renderProvider();

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ pathname: '/share-beta', params: { link: INSTAGRAM_LINK } });
    });
    expect(resetShareIntentMock).toHaveBeenCalled();
    expect(storage.has(PENDING_SHARE_KEY)).toBe(false);
  });

  it('swaps the link in place (setParams) when the share modal is already open', async () => {
    authState.isAuthenticated = true;
    segmentsState.value = ['share-beta'];
    shareState.hasShareIntent = true;
    shareState.shareIntent = { webUrl: INSTAGRAM_LINK, text: null };

    renderProvider();

    await waitFor(() => {
      expect(setParamsMock).toHaveBeenCalledWith({ link: INSTAGRAM_LINK });
    });
    // No second modal pushed — the open one is reused.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('stashes a shared link for replay when signed out', async () => {
    authState.isAuthenticated = false;
    shareState.hasShareIntent = true;
    shareState.shareIntent = { webUrl: INSTAGRAM_LINK, text: null };

    renderProvider();

    await waitFor(() => {
      expect(storage.get(PENDING_SHARE_KEY)).toBe(INSTAGRAM_LINK);
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('rejects a non-beta URL with a toast and does not route', async () => {
    authState.isAuthenticated = true;
    shareState.hasShareIntent = true;
    shareState.shareIntent = { webUrl: 'https://example.com/whatever', text: null };

    renderProvider();

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith('mobile.betaVideos.urlInvalid', 'error');
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(storage.has(PENDING_SHARE_KEY)).toBe(false);
  });

  it('replays a stashed link once authenticated and clears the stash', async () => {
    storage.set(PENDING_SHARE_KEY, INSTAGRAM_LINK);
    authState.isAuthenticated = true;
    shareState.hasShareIntent = false;

    renderProvider();

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ pathname: '/share-beta', params: { link: INSTAGRAM_LINK } });
    });
    expect(storage.has(PENDING_SHARE_KEY)).toBe(false);
  });

  it('reuses the open modal (setParams) when a stashed link is replayed after login while share-beta is already open', async () => {
    storage.set(PENDING_SHARE_KEY, INSTAGRAM_LINK);
    authState.isAuthenticated = true;
    segmentsState.value = ['share-beta'];
    shareState.hasShareIntent = false;

    renderProvider();

    await waitFor(() => {
      expect(setParamsMock).toHaveBeenCalledWith({ link: INSTAGRAM_LINK });
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(storage.has(PENDING_SHARE_KEY)).toBe(false);
  });
});
