// Vitest stub for `expo-image`.
//
// expo-image's package.json points `main` at TypeScript source (src/index.ts).
// That source imports native Expo module bindings whose untransformed TS source
// throws `SyntaxError: Unexpected token 'typeof'` in Vitest's module worker.
//
// No test in this repo renders the real Image; this stub only needs to satisfy
// static imports so Vitest's module graph resolves cleanly. Suites that assert
// Image props can register their own `vi.mock` which takes precedence.
//
// Wired via the `expo-image` alias in packages/mobile/vite.config.ts.

import type { ReactNode } from 'react';

type ImageProps = {
  source?: unknown;
  style?: unknown;
  contentFit?: string;
  recyclingKey?: string;
  children?: ReactNode;
  [key: string]: unknown;
};

export const Image = (_props: ImageProps) => null;
