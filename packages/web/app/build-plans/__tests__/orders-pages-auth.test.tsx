// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  token: vi.fn(),
  session: vi.fn(),
  query: vi.fn(),
  redirect: vi.fn((destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  }),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: control.redirect,
  notFound: (): never => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: control.session,
}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: control.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: control.query }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('@/app/lib/seo/metadata', () => ({ createNoIndexMetadata: (metadata: unknown) => metadata }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: 'test-i18n' }));
vi.mock('../build-plans-page', () => ({
  requireCncPacksFlag: async () => {},
  fetchCncCatalog: async () => ({ entries: [] }),
  isCncPacksEnabled: async () => true,
  CNC_FLAG_OFF_METADATA: {},
}));
vi.mock('../ui', () => ({ PageFrame: 'page-frame' }));
vi.mock('../orders/orders-list', () => ({ default: 'orders-list' }));
vi.mock('../orders/[licenceId]/order-status', () => ({ default: 'order-status' }));
import OrdersPage from '@/app/(site)/build-plans/orders/page';
import OrderPage from '@/app/(site)/build-plans/orders/[licenceId]/page';

const order = { licenceId: 'BS-CNC-K7QM3T', licenseeName: 'Buyer name', previewImages: ['preview-url'] };
function props() {
  return {
    params: Promise.resolve({ licenceId: order.licenceId }),
    searchParams: Promise.resolve({ checkout: ['success', 'cancelled'] }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  control.token.mockResolvedValue('buyer-token');
  control.session.mockResolvedValue({ user: { id: 'buyer-a' } });
  control.query.mockResolvedValue({ myCncOrders: [order], cncOrder: order });
});

describe('order pages and the signed-in buyer', () => {
  it('renders purchase history and order detail from the buyer token', async () => {
    const list = await OrdersPage();
    expect(JSON.stringify(list)).toContain('orders-list');
    expect(JSON.stringify(list)).toContain('Buyer name');
    const detail = await OrderPage(props());
    expect(detail.props.children.type).toBe('order-status');
    expect(detail.props.children.props).toMatchObject({
      initialOrder: order,
      initialOwnerId: 'buyer-a',
      checkoutOutcome: 'success',
      locale: 'en-US',
    });
    expect(control.query).toHaveBeenCalledWith(expect.anything(), undefined, 'buyer-token');
    expect(control.query).toHaveBeenCalledWith(expect.anything(), { licenceId: order.licenceId }, 'buyer-token');
  });

  it('sends signed-out visitors to sign-in without reading orders', async () => {
    control.token.mockResolvedValue(undefined);
    control.session.mockResolvedValue(null);
    await expect(OrdersPage()).rejects.toThrow('REDIRECT:/auth/login?callbackUrl=%2Fbuild-plans%2Forders');
    await expect(OrderPage(props())).rejects.toThrow(
      'REDIRECT:/auth/login?callbackUrl=%2Fbuild-plans%2Forders%2FBS-CNC-K7QM3T',
    );
    expect(control.query).not.toHaveBeenCalled();
  });

  it('fails the render instead of redirecting when the credential authority is unavailable', async () => {
    control.token.mockRejectedValue(new Error('AUTHORITY_UNAVAILABLE'));
    control.session.mockRejectedValue(new Error('AUTHORITY_UNAVAILABLE'));
    await expect(OrdersPage()).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    await expect(OrderPage(props())).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(control.redirect).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
  });
});
