import { render } from '@testing-library/react';

/**
 * DOM mocks otherwise accept raw text that native Views reject. Mark mocked
 * Views with data-native-view and include the route's native host (the render
 * container). Fragments have already flattened here; Text mocks remain elements.
 */
export function assertNativeTextChildren(container: HTMLElement): void {
  for (const host of [container, ...container.querySelectorAll('[data-native-view]')]) {
    for (const child of host.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent !== '') {
        throw new Error('Text strings must be rendered within a <Text> component.');
      }
    }
  }
}

export function renderWithNativeTextCheck(ui: Parameters<typeof render>[0], options?: Parameters<typeof render>[1]) {
  const result = render(ui, options);
  assertNativeTextChildren(result.container);
  return result;
}
