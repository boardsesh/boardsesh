import { createRequire } from 'node:module';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import WebSwipeable from '../reanimated-swipeable';

vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({ testID }: { testID?: string }) => <div data-testid={testID} />,
}));

const require = createRequire(import.meta.url);
const { renderToString } = require('react-dom/server') as {
  renderToString: (element: ReactElement) => string;
};

describe('browser swipeable styles', () => {
  it('ships one deduplicated stylesheet with rendered rows without a CSS loader', () => {
    const html = renderToString(
      <>
        <WebSwipeable />
        <WebSwipeable testID="second-row" />
      </>,
    );
    expect(html.match(/<style /g)).toHaveLength(1);
    expect(html).toContain('data-href="boardsesh-swipeable-touch"');
    expect(html).toContain('touch-action: pan-y !important');
    expect(html).toContain('data-boardsesh-web-swipeable="plain"');
    expect(html).toContain('data-boardsesh-web-swipeable="test-id"');
    expect(html).toContain('data-testid="second-row"');
  });
});
