import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymPageManageButton from '../gym-page-manage-button';

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => tFromCatalog(namespace, key),
    i18n: { language: 'en-US' },
  }),
}));

describe('GymPageManageButton', () => {
  it('renders the management link when mounted', () => {
    render(<GymPageManageButton gymSlug="test-gym" />);

    expect(screen.getByRole('link', { name: /manage gym/i }).getAttribute('href')).toBe('/gym/test-gym/manage');
  });
});
