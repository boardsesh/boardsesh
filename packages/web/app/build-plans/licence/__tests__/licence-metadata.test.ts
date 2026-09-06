import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import enCncLegal from '@boardsesh/i18n/locales/en-US/cnc-legal.json';

vi.mock('server-only', () => ({}));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

const getLocale = vi.hoisted(() => vi.fn(async () => 'en-US'));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale }));

const getServerFeatureFlag = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag }));

const getPosthogDistinctId = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId }));

// `notFound()` really throws in Next; the assertions below depend on that, so
// the mock throws a sentinel rather than returning quietly.
class NotFoundError extends Error {}
const notFound = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ notFound }));

// The page body and the i18n provider are React trees this suite never renders
// — stubbing them keeps the metadata + gate assertions off MUI and i18next.
vi.mock('../licence-content', () => ({ default: () => null }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: () => null }));

const route = await import('../page');

function translate(key: string): string {
  const value = key.split('.').reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === 'object' && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, enCncLegal);
  if (typeof value !== 'string') {
    throw new Error(`cnc-legal catalog has no string at "${key}"`);
  }
  return value;
}

function mockLocale(locale: string) {
  getServerTranslation.mockResolvedValue({ t: translate, i18n: {}, locale });
}

beforeEach(() => {
  getServerTranslation.mockReset();
  getServerFeatureFlag.mockReset();
  notFound.mockReset();
  notFound.mockImplementation(() => {
    throw new NotFoundError('NEXT_NOT_FOUND');
  });
  getLocale.mockResolvedValue('en-US');
  getPosthogDistinctId.mockResolvedValue(null);
  mockLocale('en-US');
});

describe('metadata', () => {
  it('ships noindex, follow while the licence is a flag-gated draft', async () => {
    const metadata = await route.generateMetadata();
    // Both halves of the gate matter: the page also 404s when the flag is off.
    // The noindex is what keeps a DRAFT licence out of the index in the window
    // between flipping the flag on and the lawyer sign-off.
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('canonicalises to the clean licence path', async () => {
    const metadata = await route.generateMetadata();
    expect(metadata.alternates?.canonical).toBe('/build-plans/licence');
  });

  it('carries the canonical into the locale prefix', async () => {
    mockLocale('de');
    const metadata = await route.generateMetadata();
    expect(metadata.alternates?.canonical).toBe('/de/build-plans/licence');
  });

  it('emits hreflang alternates for every locale plus x-default', async () => {
    const metadata = await route.generateMetadata();
    expect(metadata.alternates?.languages).toEqual({
      'en-US': '/build-plans/licence',
      es: '/es/build-plans/licence',
      fr: '/fr/build-plans/licence',
      de: '/de/build-plans/licence',
      'x-default': '/build-plans/licence',
    });
  });

  it('titles the page from the catalog, brand-suffixed', async () => {
    const metadata = await route.generateMetadata();
    expect(metadata.title).toEqual({ absolute: `${translate('metadata.licence.title')} | Boardsesh` });
  });
});

describe('feature gate', () => {
  it('404s while cnc-packs is off', async () => {
    getServerFeatureFlag.mockResolvedValue(false);
    await expect(route.default()).rejects.toBeInstanceOf(NotFoundError);
    expect(notFound).toHaveBeenCalled();
  });

  it('renders once cnc-packs is on', async () => {
    getServerFeatureFlag.mockResolvedValue(true);
    await expect(route.default()).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('evaluates the flag for the signed-in person, with allowAnonymous for everyone else', async () => {
    // Both halves are load-bearing. The distinct id has to be the session's, or
    // person-property targeting evaluates false against a stranger; and
    // `allowAnonymous` has to be on, or the page stays signed-in-only however
    // the dashboard is configured.
    getPosthogDistinctId.mockResolvedValue('user-123');
    getServerFeatureFlag.mockResolvedValue(true);
    await route.default();
    expect(getServerFeatureFlag).toHaveBeenCalledWith('cnc-packs', {
      distinctId: 'user-123',
      allowAnonymous: true,
    });
  });
});
