import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CncCatalog } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

/**
 * Covers the tier picker only: fix for a checkbox row that let a screen
 * reader believe both licence tiers could be on at once. Everything else the
 * full configurator does (draft restore, analytics, layout preview, checkout)
 * is exercised by `configurator-state.test.ts` and `use-cnc-checkout.ts`'s own
 * unit tests, so the mocks below stub those paths to their simplest values.
 */

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null }),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

const useWsAuthToken = vi.hoisted(() => vi.fn());
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken }));

vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: vi.fn().mockResolvedValue(null),
  setPreference: vi.fn().mockResolvedValue(undefined),
  removePreference: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/app/lib/cnc-funnel-analytics', () => ({
  trackCncFunnelEvent: vi.fn(),
}));

vi.mock('../configurator/use-cnc-layout', () => ({
  useCncLayout: () => ({ summary: null, isLoading: false, errorKey: null }),
}));

vi.mock('../configurator/use-cnc-checkout', () => ({
  useCncCheckout: () => ({ startCheckout: vi.fn(), isStarting: false, errorKey: null }),
}));

const ConfiguratorModule = await import('../configurator/configurator');
const Configurator = ConfiguratorModule.default;

function catalog(): CncCatalog {
  return {
    version: '1',
    entries: [
      {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: '26,27,28,29',
        label: '10x12',
        kickerOptional: false,
        manufacturingOptions: [],
        tiers: [
          { tier: 'personal', amountCents: 14900, currency: 'AUD' },
          { tier: 'commercial_single', amountCents: 75000, currency: 'AUD' },
        ],
      },
    ],
    artworkFonts: ['liberation-sans'],
    artworkRules: { maxItems: 4, minWidthMm: 40, maxWidthMm: 1200, maxTextChars: 40 },
  };
}

function renderConfigurator() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Configurator catalog={catalog()} locale="en-US" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useWsAuthToken.mockReset().mockReturnValue({ token: null, isAuthenticated: false });
});

describe('tier picker', () => {
  it('renders the two licence tiers as one mutually exclusive radio group', () => {
    renderConfigurator();

    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    // The subtitle above the tiers becomes the group's accessible name, so a
    // screen reader announces what the choice is for, not just "radio group".
    expect(group.parentElement?.textContent).toContain('Pick a licence');

    // Personal is the default, opening state.
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect((radios[1] as HTMLInputElement).checked).toBe(false);
  });

  it('selecting the commercial tier deselects personal', () => {
    renderConfigurator();

    const [personalRadio, commercialRadio] = screen.getAllByRole('radio') as HTMLInputElement[];
    fireEvent.click(commercialRadio);

    expect(commercialRadio.checked).toBe(true);
    expect(personalRadio.checked).toBe(false);
  });
});
