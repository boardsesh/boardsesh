import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Gym } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  request: vi.fn(),
  locale: { current: 'en-US' },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: mocks.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: mocks.request }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: mocks.locale.current }),
}));
vi.mock('../gym-setup', () => ({ default: () => null }));

const { default: NewGymPage, generateMetadata } = await import('../page');
const gymUuid = '87f2c9c4-bbd9-4510-8ed5-f9aad68095dd';
const gym = { uuid: gymUuid, name: 'Private Gym', isPublic: false, canEdit: true } as Gym;

beforeEach(() => {
  mocks.locale.current = 'en-US';
  mocks.token.mockReset().mockResolvedValue('token');
  mocks.request.mockReset().mockResolvedValue({ gym });
});

describe('new gym page', () => {
  it('preserves locale and the saved gym through sign-in', async () => {
    mocks.locale.current = 'fr';
    mocks.token.mockResolvedValue(null);
    const callbackUrl = encodeURIComponent(`/fr/gyms/new?gym=${gymUuid}`);
    await expect(NewGymPage({ searchParams: Promise.resolve({ gym: gymUuid }) })).rejects.toThrow(
      `REDIRECT:/fr/auth/login?callbackUrl=${callbackUrl}`,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects invalid or repeated UUIDs before sending a lookup', async () => {
    for (const candidate of ['not-a-uuid', [gymUuid, gymUuid]]) {
      await expect(NewGymPage({ searchParams: Promise.resolve({ gym: candidate }) })).rejects.toThrow('NOT_FOUND');
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('resumes a saved private gym only for a viewer with edit access', async () => {
    const rendered = await NewGymPage({ searchParams: Promise.resolve({ gym: gymUuid }) });
    expect(JSON.stringify(rendered)).toContain(gymUuid);
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), { gymUuid }, 'token');
  });

  it('makes missing, public unauthorized and private unauthorized gyms indistinguishable', async () => {
    for (const candidate of [null, { ...gym, isPublic: true, canEdit: false }, { ...gym, canEdit: false }]) {
      mocks.request.mockResolvedValueOnce({ gym: candidate });
      await expect(NewGymPage({ searchParams: Promise.resolve({ gym: gymUuid }) })).rejects.toThrow('NOT_FOUND');
    }
  });

  it('does not look up a gym before initial creation and keeps metadata generic and noindex', async () => {
    await expect(NewGymPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
    expect(mocks.request).not.toHaveBeenCalled();
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/gyms/new');
    expect(JSON.stringify(metadata)).not.toContain('Private Gym');
  });
});
