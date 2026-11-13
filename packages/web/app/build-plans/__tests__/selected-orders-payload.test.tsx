// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  viewer: vi.fn(),
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
  getServerRenderViewer: control.viewer,
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
vi.mock('../ui', () => ({ PageFrame: 'public-frame' }));
vi.mock('../orders/orders-list', () => ({ default: 'legacy-private-orders' }));
vi.mock('../orders/[licenceId]/order-status', () => ({ default: 'legacy-private-order' }));
vi.mock('../orders/selected-orders', () => ({
  SelectedOrdersList: 'selected-orders-client',
  SelectedOrderDetail: 'selected-order-client',
}));
import OrdersPage from '../orders/page';
import OrderPage from '../orders/[licenceId]/page';

const owner = {
  userId: 'buyer-a',
  authSessionId: 'buyer-login-a',
  generation: 1,
  cursor: { bindingId: 'a'.repeat(64), version: 2 },
};
const privateOrder = { licenceId: 'BS-CNC-K7QM3T', licenseeName: 'PRIVATE_BUYER_NAME', previewImages: ['PRIVATE_URL'] };
function props() {
  return {
    params: Promise.resolve({ licenceId: privateOrder.licenceId }),
    searchParams: Promise.resolve({ checkout: ['success', 'cancelled'] }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  control.viewer.mockResolvedValue({ kind: 'selected', owner });
  control.token.mockResolvedValue('PRIVATE_BEARER');
  control.session.mockResolvedValue({ user: { id: owner.userId } });
  control.query.mockResolvedValue({ myCncOrders: [privateOrder], cncOrder: privateOrder });
});

describe('selected order routes contain no private server payload', () => {
  it('sends purchase history metadata and the public catalog, without fetching orders', async () => {
    const page = await OrdersPage();
    expect(JSON.stringify(page)).toContain('selected-orders-client');
    expect(JSON.stringify(page)).toContain(owner.authSessionId);
    expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    expect(control.token).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
    expect(control.session).not.toHaveBeenCalled();
  });
  it('sends only route/catalog/owner details and preserves the first checkout outcome', async () => {
    const page = await OrderPage(props());
    expect(page.props.children.type).toBe('selected-order-client');
    expect(page.props.children.props).toEqual({
      licenceId: privateOrder.licenceId,
      owner,
      catalog: { entries: [] },
      checkoutOutcome: 'success',
      locale: 'en-US',
    });
    expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    expect(control.token).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
    expect(control.session).not.toHaveBeenCalled();
  });
  it.each(['anonymous', 'refused'])('sends %s visitors to sign-in without another credential family', async (kind) => {
    control.viewer.mockResolvedValue({ kind });
    await expect(OrdersPage()).rejects.toThrow('REDIRECT:/auth/login');
    await expect(OrderPage(props())).rejects.toThrow('REDIRECT:/auth/login');
    expect(control.token).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
    expect(control.session).not.toHaveBeenCalled();
  });
  it('propagates unavailable primary authority rather than rendering anonymous success', async () => {
    control.viewer.mockRejectedValue(new Error('AUTHORITY_UNAVAILABLE'));
    await expect(OrdersPage()).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    await expect(OrderPage(props())).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(control.redirect).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
  });
  it('retains legacy purchase history and order-detail rendering', async () => {
    control.viewer.mockResolvedValue({ kind: 'legacy' });
    const list = await OrdersPage();
    expect(JSON.stringify(list)).toContain('legacy-private-orders');
    expect(JSON.stringify(list)).toContain('PRIVATE_BUYER_NAME');
    const detail = await OrderPage(props());
    expect(detail.props.children.type).toBe('legacy-private-order');
    expect(detail.props.children.props.initialOrder).toBe(privateOrder);
  });
});
