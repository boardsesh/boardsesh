import 'fake-indexeddb/auto';
import React from 'react';
import { act, render, renderHook, waitFor, cleanup } from '@testing-library/react';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// LocaleLink calls useTranslation internally; the mock above covers it but we
// stub it anyway so the link renders without next/link's app-router context.
vi.mock('@/app/components/i18n/locale-link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { CONSENT_COOKIE, CONSENT_POLICY_VERSION, parseConsentCookie } from '@/app/lib/consent';

import ConsentBanner from '../consent-banner';
import { ConsentProvider, useConsent } from '../consent-context';
import ConsentDialog from '../consent-dialog';

const DB_NAME = 'boardsesh-user-preferences';
const STORE_NAME = 'preferences';
const META_STORE = 'preferences_meta';
const QUEUE_STORE = 'sync_queue';
const DB_VERSION = 2;

const clearAllCookies = () => {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    if (!name) continue;
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
};

const readConsentCookie = (): string | null => {
  const prefix = `${CONSENT_COOKIE}=`;
  for (const entry of document.cookie.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
};

beforeEach(async () => {
  clearAllCookies();
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { autoIncrement: true });
    },
  });
  await db.clear(STORE_NAME);
  await db.clear(META_STORE);
  await db.clear(QUEUE_STORE);
  db.close();
});

afterEach(() => {
  cleanup();
});

const wrapper =
  (initialCookieValue: string | null = null) =>
  ({ children }: { children: React.ReactNode }) => (
    <ConsentProvider initialCookieValue={initialCookieValue}>{children}</ConsentProvider>
  );

describe('ConsentProvider write paths', () => {
  it('acceptAll grants both categories and stamps decidedAt', async () => {
    const before = Date.now();
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.acceptAll();
    });

    await waitFor(() => {
      expect(result.current.state.analytics).toBe('granted');
      expect(result.current.state.errorMonitoring).toBe('granted');
    });

    const after = Date.now();
    expect(result.current.state.version).toBe(CONSENT_POLICY_VERSION);
    expect(result.current.state.decidedAt).not.toBeNull();
    expect(result.current.state.decidedAt).toBeGreaterThanOrEqual(before);
    expect(result.current.state.decidedAt).toBeLessThanOrEqual(after);
    expect(result.current.isDecided).toBe(true);
  });

  it('rejectAll denies both categories', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.rejectAll();
    });

    await waitFor(() => {
      expect(result.current.state.analytics).toBe('denied');
      expect(result.current.state.errorMonitoring).toBe('denied');
    });
    expect(result.current.isDecided).toBe(true);
  });

  it('setCategory updates only the targeted category', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setCategory('analytics', 'granted');
    });

    await waitFor(() => {
      expect(result.current.state.analytics).toBe('granted');
    });
    // errorMonitoring should still be unknown — partial decision, not decided.
    expect(result.current.state.errorMonitoring).toBe('unknown');
    expect(result.current.isDecided).toBe(false);
  });

  it('saveCategories writes both categories from the dialog', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.saveCategories({ analytics: 'granted', errorMonitoring: 'denied' });
    });

    await waitFor(() => {
      expect(result.current.state.analytics).toBe('granted');
      expect(result.current.state.errorMonitoring).toBe('denied');
    });
    expect(result.current.isDecided).toBe(true);
  });
});

describe('ConsentProvider mirror cookie', () => {
  it('writes the mirror cookie on acceptAll', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.acceptAll();
    });

    const cookie = readConsentCookie();
    expect(cookie).not.toBeNull();
    const parsed = parseConsentCookie(cookie);
    expect(parsed.analytics).toBe('granted');
    expect(parsed.errorMonitoring).toBe('granted');
    expect(parsed.version).toBe(CONSENT_POLICY_VERSION);
  });

  it('writes the mirror cookie on rejectAll', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.rejectAll();
    });

    const cookie = readConsentCookie();
    const parsed = parseConsentCookie(cookie);
    expect(parsed.analytics).toBe('denied');
    expect(parsed.errorMonitoring).toBe('denied');
  });

  it('mirror cookie round-trips a mixed save', async () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.saveCategories({ analytics: 'granted', errorMonitoring: 'denied' });
    });

    const cookie = readConsentCookie();
    const parsed = parseConsentCookie(cookie);
    expect(parsed.analytics).toBe('granted');
    expect(parsed.errorMonitoring).toBe('denied');
  });
});

describe('ConsentProvider SSR seeding', () => {
  it('treats a cookie-seeded decided state as already decided without waiting for IDB', () => {
    const seededCookie = `a=1&e=0&v=${CONSENT_POLICY_VERSION}`;
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(seededCookie) });

    // No await — the seed should kick in synchronously on first render.
    expect(result.current.isDecided).toBe(true);
    expect(result.current.state.analytics).toBe('granted');
    expect(result.current.state.errorMonitoring).toBe('denied');
    expect(result.current.isLoading).toBe(false);
  });

  it('keeps isLoading true and isDecided false when no cookie seed is present', () => {
    const { result } = renderHook(() => useConsent(), { wrapper: wrapper(null) });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isDecided).toBe(false);
  });
});

describe('useConsent outside a provider', () => {
  it('falls back to unknown state with isLoading true', () => {
    const { result } = renderHook(() => useConsent());
    expect(result.current.state.analytics).toBe('unknown');
    expect(result.current.state.errorMonitoring).toBe('unknown');
    expect(result.current.isDecided).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });
});

describe('ConsentBanner', () => {
  it('hides itself when consent is already decided (cookie seed)', () => {
    const seededCookie = `a=1&e=1&v=${CONSENT_POLICY_VERSION}`;
    const { queryByText } = render(
      <ConsentProvider initialCookieValue={seededCookie}>
        <ConsentBanner />
      </ConsentProvider>,
    );
    expect(queryByText('banner.headline')).toBeNull();
  });

  it('renders three action buttons when consent is undecided', async () => {
    const { findByRole } = render(
      <ConsentProvider initialCookieValue={null}>
        <ConsentBanner />
      </ConsentProvider>,
    );

    // useUserPreference flips isLoading false after the IDB read resolves.
    await findByRole('button', { name: 'banner.actions.acceptAll' });
    await findByRole('button', { name: 'banner.actions.reject' });
    await findByRole('button', { name: 'banner.actions.customize' });
  });
});

describe('ConsentDialog', () => {
  it('save action calls saveCategories with the toggled values', async () => {
    const onClose = vi.fn();
    // Render banner first to spin up the provider, then open the dialog directly
    // through the controlled component to assert save semantics.
    const Harness = () => {
      const { state, saveCategories } = useConsent();
      // Manually invoke the dialog with a side-channel via render hook for the writer.
      // For this test we just exercise saveCategories — the dialog's save path is the
      // same call we test in ConsentProvider, but we still want to confirm the dialog
      // wires it up.
      void state;
      void saveCategories;
      return <ConsentDialog open={true} onClose={onClose} />;
    };

    const { findByRole } = render(
      <ConsentProvider initialCookieValue={null}>
        <Harness />
      </ConsentProvider>,
    );

    const saveButton = await findByRole('button', { name: 'dialog.actions.save' });

    await act(async () => {
      saveButton.click();
    });

    // Save closes the dialog.
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });

    // And writes the mirror cookie with whatever the default toggle state is.
    // Default-when-undecided is both off (denied) — so the cookie should
    // reflect a deny/deny decision after save.
    await waitFor(() => {
      const cookie = readConsentCookie();
      expect(cookie).not.toBeNull();
      const parsed = parseConsentCookie(cookie);
      expect(parsed.analytics).toBe('denied');
      expect(parsed.errorMonitoring).toBe('denied');
    });
  });
});
