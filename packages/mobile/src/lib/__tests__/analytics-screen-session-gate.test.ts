import { describe, expect, it } from 'vitest';
import { createScreenSessionGate } from '../analytics-screen-session-gate';

const SESSION_A = '0199-aaaa';
const SESSION_B = '0199-bbbb';

function gateWith(initialSessionId: string | null | undefined) {
  let sessionId = initialSessionId;
  const gate = createScreenSessionGate(() => sessionId);
  return {
    gate,
    setSession(next: string | null | undefined) {
      sessionId = next;
    },
  };
}

describe('createScreenSessionGate', () => {
  it('emits the first time a screen is seen in a session', () => {
    const { gate } = gateWith(SESSION_A);
    expect(gate.shouldEmit('/climbs')).toBe(true);
  });

  it('suppresses the /climbs ↔ /play ping-pong down to one event each', () => {
    // The whole reason this gate exists: those two routes are 95k + 90k events a
    // month, ~34 per person, almost all of it re-visits within one session.
    const { gate } = gateWith(SESSION_A);
    const path = ['/climbs', '/play', '/climbs', '/play', '/climbs'];

    const emitted = path.filter((screen) => gate.shouldEmit(screen));

    expect(emitted).toEqual(['/climbs', '/play']);
  });

  it('emits once per distinct screen within a session', () => {
    const { gate } = gateWith(SESSION_A);
    expect(gate.shouldEmit('/climbs')).toBe(true);
    expect(gate.shouldEmit('/home')).toBe(true);
    expect(gate.shouldEmit('/climbs')).toBe(false);
  });

  it('re-arms when the session rotates', () => {
    const { gate, setSession } = gateWith(SESSION_A);
    expect(gate.shouldEmit('/climbs')).toBe(true);
    expect(gate.shouldEmit('/climbs')).toBe(false);

    setSession(SESSION_B);

    expect(gate.shouldEmit('/climbs')).toBe(true);
  });

  it('does not leak seen screens across a rotation in either direction', () => {
    const { gate, setSession } = gateWith(SESSION_A);
    gate.shouldEmit('/climbs');

    setSession(SESSION_B);
    // Seen only in A — must not be suppressed in B.
    expect(gate.shouldEmit('/climbs')).toBe(true);
    expect(gate.shouldEmit('/profile')).toBe(true);

    setSession(SESSION_A);
    // Only one session's set is retained by design, so B's /profile does not
    // suppress here either.
    expect(gate.shouldEmit('/profile')).toBe(true);
  });

  it('emits and records nothing while the session id is still empty', () => {
    // getSessionId() returns '' until the SDK hydrates its persisted storage, so
    // the first navigation of a cold launch lands here.
    const { gate, setSession } = gateWith('');
    expect(gate.shouldEmit('/home')).toBe(true);
    expect(gate.shouldEmit('/home')).toBe(true);

    setSession(SESSION_A);

    // Nothing was recorded against the empty id, so the real session still gets
    // its one event.
    expect(gate.shouldEmit('/home')).toBe(true);
    expect(gate.shouldEmit('/home')).toBe(false);
  });

  it('always emits when there is no client to report a session', () => {
    const { gate } = gateWith(null);
    expect(gate.shouldEmit('/home')).toBe(true);
    expect(gate.shouldEmit('/home')).toBe(true);
  });

  it('emits rather than dropping when reading the session id throws', () => {
    const gate = createScreenSessionGate(() => {
      throw new Error('client exploded');
    });

    expect(gate.shouldEmit('/home')).toBe(true);
    expect(gate.shouldEmit('/home')).toBe(true);
  });

  it('re-arms after reset, so a sign-out does not carry the gate to the next account', () => {
    const { gate } = gateWith(SESSION_A);
    expect(gate.shouldEmit('/climbs')).toBe(true);
    expect(gate.shouldEmit('/climbs')).toBe(false);

    gate.reset();

    expect(gate.shouldEmit('/climbs')).toBe(true);
  });
});
