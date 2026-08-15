import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymOwnerPrompts from '../gym-owner-prompts';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockFlag = vi.fn();
vi.mock('@/app/components/providers/feature-flags-provider', () => ({
  useFeatureFlag: () => mockFlag(),
}));

beforeEach(() => {
  mockFlag.mockReset();
  mockFlag.mockReturnValue(true);
});

describe('GymOwnerPrompts', () => {
  it('renders a deep-linked card for each missing piece', () => {
    render(
      <GymOwnerPrompts
        gymSlug="test-gym"
        canEdit
        hasBoards={false}
        hasHours={false}
        hasDescription={false}
        hasKiosk={false}
        hasBranding={false}
      />,
    );

    expect(screen.getByRole('link', { name: /link your boards/i }).getAttribute('href')).toBe(
      '/gym/test-gym/manage?tab=boards',
    );
    expect(screen.getByRole('link', { name: /put this wall on a tv/i }).getAttribute('href')).toBe(
      '/gym/test-gym/manage?tab=kiosks',
    );
    expect(screen.getByRole('link', { name: /add your branding/i }).getAttribute('href')).toBe(
      '/gym/test-gym/manage?tab=branding',
    );
    // Hours and description are edited on the same Profile tab.
    expect(screen.getByRole('link', { name: /add your opening hours/i }).getAttribute('href')).toBe(
      '/gym/test-gym/manage?tab=profile',
    );
    expect(screen.getByRole('link', { name: /say what climbing here is like/i }).getAttribute('href')).toBe(
      '/gym/test-gym/manage?tab=profile',
    );
  });

  it('renders only the prompt for the missing piece', () => {
    render(
      <GymOwnerPrompts gymSlug="test-gym" canEdit hasBoards hasHours hasDescription hasKiosk={false} hasBranding />,
    );

    expect(screen.getByRole('link', { name: /put this wall on a tv/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /link your boards/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /add your branding/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /add your opening hours/i })).toBeNull();
  });

  it('nudges for hours alone once everything else is filled in', () => {
    render(
      <GymOwnerPrompts gymSlug="test-gym" canEdit hasBoards hasHours={false} hasDescription hasKiosk hasBranding />,
    );

    expect(screen.getByRole('link', { name: /add your opening hours/i }).getAttribute('href')).toBe(
      '/gym/test-gym/manage?tab=profile',
    );
    expect(screen.queryByRole('link', { name: /say what climbing here is like/i })).toBeNull();
  });

  it('renders nothing when the gym is fully set up', () => {
    const { container } = render(
      <GymOwnerPrompts gymSlug="test-gym" canEdit hasBoards hasHours hasDescription hasKiosk hasBranding />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while the kiosk flag is off', () => {
    mockFlag.mockReturnValue(false);
    const { container } = render(
      <GymOwnerPrompts
        gymSlug="test-gym"
        canEdit
        hasBoards={false}
        hasHours={false}
        hasDescription={false}
        hasKiosk={false}
        hasBranding={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('self-gates a non-editor to nothing (the public page renders it unconditionally)', () => {
    const { container } = render(
      <GymOwnerPrompts
        gymSlug="test-gym"
        canEdit={false}
        hasBoards={false}
        hasHours={false}
        hasDescription={false}
        hasKiosk={false}
        hasBranding={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
