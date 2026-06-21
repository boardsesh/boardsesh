// Test stub for react-native-paper. The real entry pulls in untransformed
// RN-native source (and react-native-vector-icons) that throws a SyntaxError
// under vitest's node env — the same problem the posthog stub solves. This keeps
// react-native-paper importable in every suite (integration tests that render a
// Paper-using primitive without their own mock). Component-specific tests that
// assert Paper props still register their own `vi.mock('react-native-paper', …)`,
// which takes precedence over this alias for that file.
import { createElement, type ReactNode } from 'react';

type StubProps = Record<string, unknown> & { children?: ReactNode };

const stub =
  (name: string) =>
  ({ children }: StubProps) =>
    createElement('div', { 'data-paper': name }, children);

export const PaperProvider = ({ children }: StubProps) => createElement('div', { 'data-paper': 'provider' }, children);
export const Button = stub('button');
export const IconButton = stub('icon-button');
export const Switch = stub('switch');
export const Badge = stub('badge');
export const Snackbar = stub('snackbar');
export const Searchbar = stub('searchbar');
export const Chip = stub('chip');
export const Appbar = {
  Header: stub('appbar-header'),
  Content: stub('appbar-content'),
  Action: stub('appbar-action'),
};
export const SegmentedButtons = stub('segmented-buttons');
export const FAB = stub('fab');
export const ActivityIndicator = stub('activity-indicator');
export const TouchableRipple = stub('touchable-ripple');

const CardStub = stub('card');
export const Card = Object.assign(CardStub, {
  Content: stub('card-content'),
  Title: stub('card-title'),
  Actions: stub('card-actions'),
});

export const MD3LightTheme = { dark: false, roundness: 5, colors: { elevation: {} }, fonts: {} };
export const MD3DarkTheme = { dark: true, roundness: 5, colors: { elevation: {} }, fonts: {} };
