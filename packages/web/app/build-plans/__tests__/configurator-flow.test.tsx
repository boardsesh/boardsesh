import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CncCatalog, CncOrder } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

/**
 * The preview-first flow, end to end through the component: who may ask for a
 * preview, what happens to it when the wall changes underneath it, and what has
 * to be true before anybody can be charged.
 *
 * The GraphQL client is mocked at the transport, not the hooks, so the wiring
 * under test is the real one — `createCncPreview` really is the call the button
 * makes, and `finaliseCncOrder` really does carry the previewed order's id. The
 * layout and artwork-validation hooks stay stubbed: both debounce against
 * timers and neither has anything to say about this flow.
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

const openAuthModal = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal }),
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

const graphqlRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
  getGraphQLHttpUrl: () => 'https://api.boardsesh.test/graphql',
}));

vi.mock('../configurator/use-cnc-layout', () => ({
  useCncLayout: () => ({ summary: null, model: null, isLoading: false, errorKey: null }),
}));

vi.mock('../configurator/use-cnc-artwork-validation', () => ({
  useCncArtworkValidation: () => ({ ok: null, collisions: [], isChecking: false, errorKey: null }),
}));

const ConfiguratorModule = await import('../configurator/configurator');
const Configurator = ConfiguratorModule.default;

const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3';
const locationAssign = vi.fn();

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
        manufacturingOptions: [
          {
            key: 'engraveHoldIds',
            values: ['false', 'true'],
            defaultValue: 'true',
            valueType: 'boolean',
            kickerOnly: false,
          },
        ],
        tiers: [
          { tier: 'personal', amountCents: 14900, currency: 'AUD' },
          { tier: 'commercial_single', amountCents: 75000, currency: 'AUD' },
        ],
      },
    ],
    artworkFonts: ['liberation-sans'],
    artworkRules: { maxItems: 4, minWidthMm: 40, maxWidthMm: 1200, maxTextChars: 40, allowedKinds: ['text', 'svg'] },
  };
}

function readyOrder(): CncOrder {
  return {
    id: '41',
    licenceId: 'BS-CNC-K7QM3T',
    tier: null,
    status: 'preview_ready',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: {},
    artwork: null,
    licenseeName: null,
    customerSiteName: null,
    amountCents: null,
    currency: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    paidAt: null,
    generatedAt: null,
    zipSizeBytes: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    errorMessage: null,
    hasPreview: true,
    previewGeneratedAt: '2026-09-07T00:00:30.000Z',
    previewImages: [{ name: 'panel1.png', url: 'https://api.boardsesh.test/preview/panel1.png?token=abc' }],
    configHash: 'sha256-of-the-wall',
  };
}

/** Route by operation, the way the backend does — one mock, every call the flow makes. */
function respond(document: string) {
  if (document.includes('mutation CreateCncPreview')) return Promise.resolve({ createCncPreview: readyOrder() });
  if (document.includes('query GetCncOrder')) return Promise.resolve({ cncOrder: readyOrder() });
  if (document.includes('mutation FinaliseCncOrder')) {
    return Promise.resolve({
      finaliseCncOrder: { orderId: '41', licenceId: 'BS-CNC-K7QM3T', checkoutUrl: STRIPE_URL },
    });
  }
  return Promise.resolve({});
}

function renderConfigurator() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Configurator catalog={catalog()} locale="en-US" />
    </QueryClientProvider>,
  );
}

/** The variables one operation was sent with, or undefined if it never was. */
function sentCall(operation: string): unknown {
  const call = graphqlRequest.mock.calls.find((args) => String(args[0]).includes(operation));
  return call?.[1];
}

/** The rail's one button, whatever it currently says. */
function primaryAction(): HTMLButtonElement {
  const button =
    screen.queryByRole('button', { name: /free preview|Update preview|Finalise and buy|Drawing your preview/i }) ??
    null;
  if (!button) throw new Error('the rail has no primary action');
  return button as HTMLButtonElement;
}

async function previewThisWall() {
  fireEvent.click(primaryAction());
  await screen.findByRole('button', { name: 'Finalise and buy' });
}

beforeEach(() => {
  openAuthModal.mockReset();
  graphqlRequest.mockReset().mockImplementation((document: string) => respond(document));
  locationAssign.mockReset();
  useWsAuthToken.mockReset().mockReturnValue({ token: 'ws-token', isAuthenticated: true });
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { assign: locationAssign, origin: 'http://localhost', href: 'http://localhost/build-plans' },
  });
});

describe('the preview step', () => {
  it('asks a signed-out buyer to sign in rather than calling the generator', async () => {
    useWsAuthToken.mockReturnValue({ token: null, isAuthenticated: false });
    renderConfigurator();

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in for a free preview' }));

    await waitFor(() => expect(openAuthModal).toHaveBeenCalled());
    expect(openAuthModal.mock.calls[0][0]).toMatchObject({ callbackUrl: '/build-plans' });
    expect(graphqlRequest).not.toHaveBeenCalled();
  });

  it('previews the wall on screen and shows the watermarked sheets', async () => {
    renderConfigurator();

    fireEvent.click(await screen.findByRole('button', { name: 'Get a free preview' }));

    await waitFor(() => {
      const previewCall = sentCall('mutation CreateCncPreview');
      expect(previewCall).toMatchObject({ config: { boardName: 'kilter', sizeId: 25 } });
    });

    // Nothing dims, crops or lightboxes the sheets: the watermark is the point
    // of this screen, so the tile is a plain image with its own caption.
    expect(await screen.findByRole('img', { name: 'Panel 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Download the preview' })).toBeDefined();
  });

  it('turns the same button into "Update preview" once the wall changes underneath it', async () => {
    renderConfigurator();
    await previewThisWall();

    // MUI's Switch is `role="switch"`; the licence tick below is the page's
    // only `checkbox`.
    fireEvent.click(screen.getByRole('switch', { name: 'Engrave hold numbers' }));

    // Same button, same place, changed label — never a second preview button.
    await screen.findByRole('button', { name: 'Update preview' });
    expect(screen.queryByRole('button', { name: 'Finalise and buy' })).toBeNull();
  });
});

describe('the finalise step', () => {
  it('is not offered at all until a preview is ready', async () => {
    renderConfigurator();

    await screen.findByRole('button', { name: 'Get a free preview' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finalise and buy' })).toBeNull();
  });

  it('stays disabled until the licence questions are answered', async () => {
    renderConfigurator();
    await previewThisWall();

    expect(primaryAction().disabled).toBe(true);
    // A disabled button always says why.
    expect(screen.getByText('Fill this in before you buy.')).toBeDefined();
  });

  it('offers the two tiers as one mutually exclusive choice', async () => {
    renderConfigurator();
    await previewThisWall();

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);

    fireEvent.click(radios[1]);
    expect(radios[1].checked).toBe(true);
    expect(radios[0].checked).toBe(false);
  });

  it('buys the previewed order by id and sends the browser to Stripe', async () => {
    renderConfigurator();
    await previewThisWall();

    fireEvent.change(screen.getByLabelText(/Name on the licence/), { target: { value: 'Sam Bouldering' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'sam@example.com' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'I accept the manufacturing licence' }));

    await waitFor(() => expect(primaryAction().disabled).toBe(false));
    fireEvent.click(primaryAction());

    await waitFor(() => {
      const finaliseCall = sentCall('mutation FinaliseCncOrder');
      // The order id is the whole contract: the wall itself is already on the
      // order the preview created.
      expect(finaliseCall).toEqual({
        input: {
          orderId: '41',
          tier: 'personal',
          licenseeName: 'Sam Bouldering',
          licenseeEmail: 'sam@example.com',
          customerSiteName: null,
          acceptLicence: true,
        },
      });
    });
    await waitFor(() => expect(locationAssign).toHaveBeenCalledWith(STRIPE_URL));
  });
});
