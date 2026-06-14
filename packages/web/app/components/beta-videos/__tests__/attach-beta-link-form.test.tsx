import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key;
      return Object.entries(vars).reduce((out, [name, value]) => out.replace(`{{${name}}}`, String(value)), key);
    },
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token' }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: vi.fn() }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  ATTACH_BETA_LINK: 'ATTACH_BETA_LINK',
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/lib/instagram-posting', () => ({
  buildInstagramCaption: ({ climbName, angle }: { climbName: string; angle: number }) =>
    `"${climbName}" @ ${angle}° caption`,
  copyAndOpenInstagram: vi.fn(),
}));

import AttachBetaLinkForm from '../attach-beta-link-form';

function renderForm(props: Partial<React.ComponentProps<typeof AttachBetaLinkForm>> = {}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AttachBetaLinkForm boardType="kilter" climbUuid="climb-1" climbName="Crimpy" angle={40} {...props} />
    </QueryClientProvider>,
  );
}

describe('AttachBetaLinkForm — showStepsGuide', () => {
  it('renders the three numbered step titles when showStepsGuide is true', () => {
    renderForm({ showStepsGuide: true });

    expect(screen.getByText('betaVideos.steps.step1Title')).toBeTruthy();
    expect(screen.getByText('betaVideos.steps.step2Title')).toBeTruthy();
    expect(screen.getByText('betaVideos.steps.step3Title')).toBeTruthy();
  });

  it('marks step 1 and step 2 as Optional but not step 3', () => {
    renderForm({ showStepsGuide: true });

    const optionalBadges = screen.getAllByText('(betaVideos.steps.optional)');
    expect(optionalBadges).toHaveLength(2);
  });

  it('hides the floating URL label when steps are shown but keeps the input accessibly named', () => {
    renderForm({ showStepsGuide: true });

    // The floating <label> text should not appear (label prop is unset).
    expect(screen.queryByText('betaVideos.urlLabelForClimb')).toBeNull();
    // The accessible name must still be on the <input> itself (via
    // inputProps), not just the FormControl root — otherwise screen
    // readers announce an unlabeled textbox.
    const input = screen.getByRole('textbox', { name: 'betaVideos.urlLabelForClimb' });
    expect(input.tagName).toBe('INPUT');
  });

  it('keeps the floating URL label in the flat (default) layout', () => {
    renderForm();

    expect(screen.queryByText('betaVideos.steps.step1Title')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'betaVideos.urlLabelForClimb' });
    expect(input.tagName).toBe('INPUT');
  });

  it('renders the Copy & open Instagram button when climbName and angle are present', () => {
    renderForm({ showStepsGuide: true });

    expect(screen.getByRole('button', { name: 'betaVideos.copyAndOpenInstagram' })).toBeTruthy();
  });

  it('can hide the Copy & open Instagram button in manual fallback flows', () => {
    renderForm({ showInstagramButton: false });

    expect(screen.queryByRole('button', { name: 'betaVideos.copyAndOpenInstagram' })).toBeNull();
  });

  it('omits the Instagram button when angle is missing, but keeps all three steps numbered', () => {
    renderForm({ showStepsGuide: true, angle: null });

    expect(screen.getByText('betaVideos.steps.step1Title')).toBeTruthy();
    expect(screen.getByText('betaVideos.steps.step2Title')).toBeTruthy();
    expect(screen.getByText('betaVideos.steps.step3Title')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'betaVideos.copyAndOpenInstagram' })).toBeNull();
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByText('3.')).toBeTruthy();
  });
});
