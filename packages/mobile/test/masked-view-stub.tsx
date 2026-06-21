// Test stub for @react-native-masked-view/masked-view. The real entry is a native
// module that can't load under vitest's node/jsdom env. MaskedView renders its
// children (the masked content) so they stay in the tree; the gradient mask itself
// isn't asserted. Suites that need to assert the mask register their own vi.mock,
// which takes precedence over this alias.
import { createElement, type ReactNode } from 'react';

export default function MaskedView({ children }: { children?: ReactNode; maskElement?: ReactNode }) {
  return createElement('div', { 'data-testid': 'masked-view' }, children);
}
