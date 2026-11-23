import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { resolveClaimCtaVariant } from '../gym-claim-cta-logic';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/components/gym-entity/claim-gym-dialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="claim-dialog" /> : null),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const openAuthModal = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal }),
}));

const routerRefresh = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, replace: routerReplace, push: vi.fn() }),
}));

const GymClaimCta = (await import('../gym-claim-cta')).default;
const GymClaimParamCleanup = (await import('../gym-claim-param-cleanup')).default;

type AuthModalConfig = {
  title?: string;
  description?: string;
  callbackUrl?: string;
  onSuccess?: () => void;
};

const lastAuthModalConfig = (): AuthModalConfig => openAuthModal.mock.calls.at(-1)?.[0] as AuthModalConfig;

const renderCta = (props: Partial<React.ComponentProps<typeof GymClaimCta>> = {}) =>
  render(
    <GymClaimCta
      gymUuid="gym-1"
      gymName="Boulderwelt"
      gymSlug="boulderwelt"
      website={null}
      canClaimByDomain={false}
      viewerState="signed-in"
      {...props}
    />,
  );

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
  openAuthModal.mockReset();
  routerRefresh.mockReset();
  routerReplace.mockReset();
  window.history.replaceState(null, '', '/gym/boulderwelt');
});

describe('GymClaimCta — signed-in arm', () => {
  it('reports the click with the server-derived viewer state', () => {
    renderCta();

    fireEvent.click(screen.getByRole('button', { name: 'Claim this gym' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'gym-page', viewerState: 'signed-in', gymUuid: 'gym-1' },
    });
  });

  it('opens the dialog directly, without routing through auth', () => {
    renderCta();

    expect(screen.queryByTestId('claim-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Claim this gym' }));

    expect(screen.getByTestId('claim-dialog')).toBeTruthy();
    expect(openAuthModal).not.toHaveBeenCalled();
  });
});

describe('GymClaimCta — signed-out arm', () => {
  it('renders the same call-out copy so anonymous visitors get it server-rendered', () => {
    renderCta({ viewerState: 'signed-out' });

    expect(screen.getByText('Is this your gym?')).toBeTruthy();
    expect(screen.getByText('Claim it to run the boards, the branding, and what shows up on the wall.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in and claim it' })).toBeTruthy();
  });

  it('sends the owner through auth with a callback back to this gym page', () => {
    renderCta({ viewerState: 'signed-out' });

    fireEvent.click(screen.getByRole('button', { name: 'Log in and claim it' }));

    // OAuth leaves the page, so this URL is the only place the claim intent
    // survives — without it SocialLoginButtons defaults the return to '/'.
    expect(lastAuthModalConfig().callbackUrl).toBe('/gym/boulderwelt?claim=1');
    expect(screen.queryByTestId('claim-dialog')).toBeNull();
  });

  it('reports the click as signed-out — the state that was unreachable before this arm existed', () => {
    renderCta({ viewerState: 'signed-out' });

    fireEvent.click(screen.getByRole('button', { name: 'Log in and claim it' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'gym-page', viewerState: 'signed-out', gymUuid: 'gym-1' },
    });
  });

  it('opens the claim dialog and refreshes the server render once auth succeeds', () => {
    renderCta({ viewerState: 'signed-out' });
    fireEvent.click(screen.getByRole('button', { name: 'Log in and claim it' }));

    // Fired by the modal, not by a React event handler, so it needs the act
    // wrapper the way the provider's own success path would deliver it.
    act(() => lastAuthModalConfig().onSuccess?.());

    expect(screen.getByTestId('claim-dialog')).toBeTruthy();
    // `canClaim` is server-computed, so the refresh is what clears the call-out
    // for someone who turns out to already have edit access.
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('GymClaimCta — returning from auth on ?claim=1', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the deferred URL cleanup run. */
  const flushStrip = () => act(() => void vi.runAllTimers());

  it('opens the dialog immediately and strips the param without a router navigation', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?claim=1&src=qr');

    renderCta({ claimParam: '1' });

    // Immediate: a dialog that waits a tick to appear reads as a dropped tap.
    expect(screen.getByTestId('claim-dialog')).toBeTruthy();

    flushStrip();

    expect(window.location.search).toBe('?src=qr');
    // `router.replace` refetches the RSC payload and would remount this island,
    // closing the dialog it just opened.
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('defers the strip so a replaceState patch installed after mount still handles it', () => {
    // Next patches `history.replaceState` in the root Router's own mount
    // effect, and React flushes passive effects child-first — so at the moment
    // this island's effect runs, the patch is not installed yet. Stripping
    // through the unpatched function leaves the router's canonicalUrl on
    // `?claim=1`, and the next commit writes the param back.
    window.history.replaceState(null, '', '/gym/boulderwelt?claim=1');
    const nativeReplaceState = window.history.replaceState.bind(window.history);

    renderCta({ claimParam: '1' });

    // Stands in for the patch, installed the way Next installs it: after this
    // island's effect has already run.
    const patchedReplaceState = vi.fn(nativeReplaceState);
    window.history.replaceState = patchedReplaceState;
    try {
      expect(window.location.search).toBe('?claim=1');

      flushStrip();

      expect(patchedReplaceState).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe('');
    } finally {
      window.history.replaceState = nativeReplaceState;
    }
  });

  it('strips the param on the signed-out arm too, without opening anything', () => {
    // Someone opened a shared `?claim=1` link while logged out. The param is
    // just as stale for them, and there is no session to claim with.
    window.history.replaceState(null, '', '/gym/boulderwelt?claim=1');

    renderCta({ viewerState: 'signed-out', claimParam: '1' });
    flushStrip();

    expect(screen.queryByTestId('claim-dialog')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('does not auto-open or strip for a repeated param', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?claim=1&claim=1');

    renderCta({ claimParam: ['1', '1'] });
    flushStrip();

    expect(screen.queryByTestId('claim-dialog')).toBeNull();
    expect(window.location.search).toBe('?claim=1&claim=1');
  });

  it('cancels the pending strip when the island unmounts first', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?claim=1');

    const { unmount } = renderCta({ claimParam: '1' });
    unmount();
    flushStrip();

    expect(window.location.search).toBe('?claim=1');
  });
});

describe('GymClaimParamCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears a stale claim param on the pages where no call-out renders', () => {
    // An owner or covering community leader who came back from auth: their
    // variant is `hidden`, so nothing would otherwise clear the param.
    window.history.replaceState(null, '', '/gym/boulderwelt?claim=1&src=qr');

    render(<GymClaimParamCleanup claimParam="1" />);
    act(() => void vi.runAllTimers());

    expect(window.location.search).toBe('?src=qr');
  });

  it('leaves an untouched URL alone', () => {
    window.history.replaceState(null, '', '/gym/boulderwelt?src=qr');

    render(<GymClaimParamCleanup />);
    act(() => void vi.runAllTimers());

    expect(window.location.search).toBe('?src=qr');
  });
});

/**
 * Mirrors the render condition in `page.tsx`. The gating lives on the server,
 * so the island itself always paints — these assertions are about who ever gets
 * it mounted at all (the #3672 visibility-gating gap).
 */
function GatedClaimCta({
  isPublic,
  canClaim,
  hasSession,
  isClaimed = false,
}: {
  isPublic: boolean;
  canClaim: boolean;
  hasSession: boolean;
  isClaimed?: boolean;
}) {
  const variant = resolveClaimCtaVariant({
    serverCanClaim: canClaim,
    serverHasSession: hasSession,
    gymIsClaimed: isClaimed,
  });
  if (!isPublic || variant === 'hidden') return null;
  return (
    <GymClaimCta
      gymUuid="gym-1"
      gymName="Boulderwelt"
      gymSlug="boulderwelt"
      website={null}
      canClaimByDomain={false}
      viewerState={variant}
    />
  );
}

describe('claim CTA visibility gating', () => {
  it('renders nothing for a signed-in viewer who already covers the gym', () => {
    // Owner, gym admin/editor, covering community leader: all `canClaim: false`.
    const { container } = render(<GatedClaimCta isPublic canClaim={false} hasSession />);

    expect(container.innerHTML).toBe('');
    expect(trackGymFunnelEvent).not.toHaveBeenCalled();
  });

  it('renders the claim button for a signed-in viewer who may claim', () => {
    render(<GatedClaimCta isPublic canClaim hasSession />);
    expect(screen.getByRole('button', { name: 'Claim this gym' })).toBeTruthy();
  });

  it('renders the anonymous arm on a public gym nobody has claimed', () => {
    render(<GatedClaimCta isPublic canClaim={false} hasSession={false} />);
    expect(screen.getByRole('button', { name: 'Log in and claim it' })).toBeTruthy();
  });

  it('never renders the anonymous arm on a gym that already has an owner', () => {
    // The owner's name is displayed directly above where the box would sit.
    const { container } = render(<GatedClaimCta isPublic canClaim={false} hasSession={false} isClaimed />);

    expect(container.innerHTML).toBe('');
    expect(trackGymFunnelEvent).not.toHaveBeenCalled();
  });

  it('still renders the signed-in arm on a claimed gym', () => {
    // Asking for a gym someone else owns is an existing, deliberate path.
    render(<GatedClaimCta isPublic canClaim hasSession isClaimed />);
    expect(screen.getByRole('button', { name: 'Claim this gym' })).toBeTruthy();
  });

  it('never renders the anonymous arm on a private gym', () => {
    const { container } = render(<GatedClaimCta isPublic={false} canClaim={false} hasSession={false} />);
    expect(container.innerHTML).toBe('');
  });
});
