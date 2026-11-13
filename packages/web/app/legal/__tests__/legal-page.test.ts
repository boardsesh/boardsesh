import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CNC_PACKS_FLAG } from '@/app/flags';

vi.mock('server-only', () => ({}));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

const getLocale = vi.hoisted(() => vi.fn(async () => 'en-US'));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale }));

const getServerFeatureFlag = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag }));

// Spy components rather than the real trees: this suite is about the gate and
// the prop it produces, so keeping MUI and i18next out of it means a styling
// change can never turn one of these assertions red.
const LegalContent = vi.hoisted(() => vi.fn(() => null));
vi.mock('../legal-content', () => ({ default: LegalContent }));
const I18nProvider = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: I18nProvider }));

const route = await import('../page');

beforeEach(() => {
  getServerFeatureFlag.mockReset();
  getLocale.mockResolvedValue('en-US');
  getServerTranslation.mockResolvedValue({ t: (key: string) => key, i18n: {}, locale: 'en-US' });
});

// The page never renders here — it returns the provider element with the
// content element as its only child, so reading that child's props is the same
// thing React would hand the component, without a DOM.
async function renderLegalPage() {
  const tree = (await route.default()) as ReactElement<{ children: ReactElement<{ showBuildPlans: boolean }> }>;
  expect(tree.type).toBe(I18nProvider);
  const content = tree.props.children;
  expect(content.type).toBe(LegalContent);
  return content.props;
}

describe('LegalPage build-plans gate', () => {
  it('resolves the flag anonymously, without a distinct id', async () => {
    // Both arguments are load-bearing. `distinctId: null` keeps the cached flag
    // lookup to a single entry, because the answer is identical for everybody;
    // `allowAnonymous` keeps it resolvable for the signed-out visitors who are
    // most of /legal's traffic.
    getServerFeatureFlag.mockResolvedValue(false);
    await route.default();
    expect(getServerFeatureFlag).toHaveBeenCalledWith(CNC_PACKS_FLAG, {
      distinctId: null,
      allowAnonymous: true,
    });
  });

  it('shows the build-plans section once cnc-packs is on', async () => {
    getServerFeatureFlag.mockResolvedValue(true);
    await expect(renderLegalPage()).resolves.toEqual({ showBuildPlans: true });
  });

  it('hides the build-plans section while cnc-packs is off', async () => {
    // /legal is indexed, and `/build-plans/licence` 404s while the flag is off.
    // Passing `false` here is what keeps an indexed page from linking into a 404.
    getServerFeatureFlag.mockResolvedValue(false);
    await expect(renderLegalPage()).resolves.toEqual({ showBuildPlans: false });
  });
});
