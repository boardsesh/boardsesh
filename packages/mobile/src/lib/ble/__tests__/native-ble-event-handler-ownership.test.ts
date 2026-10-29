import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// BoardBleManager is a native singleton that outlives the JS runtime, while
// every runtime gets its own BoardBleModule. On a reload (an OTA reloadAsync)
// Expo creates the new module before the old runtime finishes tearing down, so
// the old module's OnDestroy can run after the new module's OnCreate installed
// its handlers. A destroy that cleared the handlers unconditionally wiped the
// new module's handlers: scans ran, but no result reached JS, and the picker
// showed "No boards found nearby" until the app restarted (#7023).
//
// The ownership rule itself is covered by the native XCTests in
// ios-tests/BoardBleDisconnectTests.swift (run by ios-rn-ci). This guard keeps
// the module wiring that the XCTests cannot reach: the module must register
// with an owner and clear only by that owner.

const MODULE_SOURCE = readFileSync(
  join(__dirname, '../../../../modules/live-activity/ios/BoardBleModule.swift'),
  'utf8',
);

/** The body of the first `<name> { ... }` block, matched by brace depth. */
function blockBody(source: string, name: string): string {
  const start = source.indexOf(`${name} {`);
  if (start === -1) throw new Error(`${name} block not found in BoardBleModule.swift`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '{') depth++;
    if (character === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name} block is not closed in BoardBleModule.swift`);
}

describe('BoardBleModule event handler ownership (#7023)', () => {
  it('registers its handlers under its own owner token', () => {
    const onCreate = blockBody(MODULE_SOURCE, 'OnCreate');
    expect(onCreate).toMatch(/setEventHandlers\(\s*owner:\s*self\.eventHandlerOwner,/);
  });

  it('clears only the handlers it owns when destroyed', () => {
    const onDestroy = blockBody(MODULE_SOURCE, 'OnDestroy');
    expect(onDestroy).toContain('clearEventHandlers(owner: self.eventHandlerOwner)');
    expect(onDestroy).not.toContain('setEventHandlers');
  });
});
