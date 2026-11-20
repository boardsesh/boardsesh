// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const share = vi.hoisted(() => vi.fn());
vi.mock('../../ShareIconButton', () => ({
  ShareIconButton: (props: { url: string; prewarmOgImageUrl: string }) => {
    share(props);
    return createElement('button', { 'aria-label': 'Share gym', 'data-url': props.url });
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
vi.mock('../../../lib/share-prewarm', () => ({
  buildPlaceOgImageUrl: (kind: string, slug: string) =>
    `https://ws.boardsesh.com/og/place?kind=${kind}&slug=${encodeURIComponent(slug)}`,
}));

import { GymShareButton } from '../GymShareButton';

describe('gym sharing', () => {
  it('shares the public gym browser page with its place card', () => {
    share.mockClear();
    const { getByRole } = render(<GymShareButton gym={{ name: 'The Crag', slug: 'the crag', isPublic: true }} />);
    expect(getByRole('button', { name: 'Share gym' }).getAttribute('data-url')).toBe(
      'https://www.boardsesh.com/gym/the%20crag',
    );
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ prewarmOgImageUrl: 'https://ws.boardsesh.com/og/place?kind=gym&slug=the%20crag' }),
    );
  });

  it.each([
    { name: 'Private gym', slug: 'private', isPublic: false },
    { name: 'Missing slug', slug: undefined, isPublic: true },
    { name: 'Empty slug', slug: '', isPublic: true },
  ])('hides Share for $name', (gym) => {
    const { queryByRole } = render(<GymShareButton gym={gym} />);
    expect(queryByRole('button')).toBeNull();
  });
});
