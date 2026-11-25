import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));
const availability = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-mcp/availability.server', () => ({ getGymMcpAvailability: availability }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string) => tFromCatalog(namespace, key),
    locale: 'en-US',
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLocaleLink(props, ref) {
      return <a {...props} ref={ref} />;
    },
  ),
}));
const { default: GymMcpGuidePage, generateMetadata } = await import('@/app/(site)/developers/gym-mcp/page');

beforeEach(() => {
  availability.mockResolvedValue({ enabled: true, invitationRequired: false });
});

describe('hosted gym MCP setup guide', () => {
  it('renders useful setup copy and account links without a developer registration requirement', async () => {
    render(await GymMcpGuidePage());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText('Hosted MCP server URL').getAttribute('value')).toBe(
      'https://api.boardsesh.com/mcp/gyms',
    );
    expect(screen.getByText(/You do not install anything or register a developer app/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Manage connected apps' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Find your gym' }).getAttribute('href')).toBe('/gyms');
    expect(screen.getByText(/The assistant controls when approval appears/)).toBeTruthy();
  });

  it('classifies setup as a noindex utility with canonical and social metadata', async () => {
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/developers/gym-mcp');
    expect(metadata.openGraph?.title).toBeTruthy();
    expect(metadata.twitter?.title).toBeTruthy();
  });

  it('explains invitation-only pilot access before the sign-in instructions', async () => {
    availability.mockResolvedValue({ enabled: true, invitationRequired: true });
    render(await GymMcpGuidePage());
    const invitationNotice = screen.getByText(/Only invited Boardsesh accounts can connect/);
    const signInInstruction = screen.getByText(/Sign in to Boardsesh and review the gym permissions/);
    expect(invitationNotice.textContent).toContain('Wait for your invitation');
    expect(invitationNotice.compareDocumentPosition(signInInstruction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
