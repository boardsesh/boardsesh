import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// onAnalyticsReady (src/lib/analytics.ts) waits on `ready()`, which the SDK
// typings mark @internal. It is the only way to learn that the SDK has loaded
// its persisted ids, and on the first moments of a launch identity is
// reconciled from its callback. Typecheck catches a removal from the typings;
// this catches the method leaving the shipped build on an SDK bump.
//
// It reads the built file because Vitest aliases `posthog-react-native` to a
// stub (the real entry needs React Native), so the class cannot be imported.
describe('posthog-react-native contract', () => {
  it('still ships ready() on the client class', () => {
    const builtClient = readFileSync(
      fileURLToPath(new URL('../../../node_modules/posthog-react-native/dist/posthog-rn.js', import.meta.url)),
      'utf8',
    );
    // Any way a bundler can define the method: a property descriptor
    // (`key:"ready"`, whitespace and quote style vary by minifier), a class
    // method (`ready(` / `async ready(`), or a prototype assignment.
    const readyDefinition = /key\s*:\s*["']ready["']|(?:^|[\s,{;])(?:async\s+)?ready\s*\(|\.prototype\.ready\s*=/;
    expect(builtClient).toMatch(readyDefinition);
  });
});
