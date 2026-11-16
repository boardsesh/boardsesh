import { describe, expect, it } from 'vite-plus/test';
import { reportedClientLimitKey } from '../../../utils/client-ip';
import {
  createPasswordCompareGate,
  PasswordComparesSaturatedError,
  type PasswordCompareLane,
} from '../password-compare-gate';

function held() {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, done };
}

describe('password compare gate', () => {
  it('runs one compare at a time and lets a first attempt overtake every repeat attempt', async () => {
    const gate = createPasswordCompareGate(1, 2);
    const order: string[] = [];
    const blocker = held();
    const running = gate.run('repeat', async () => {
      order.push('running');
      await blocker.done;
    });
    const queued = (lane: PasswordCompareLane, name: string) =>
      gate.run(lane, async () => {
        order.push(name);
      });
    const waiting = [queued('repeat', 'repeat-1'), queued('repeat', 'repeat-2'), queued('first', 'first-1')];
    expect(order).toEqual(['running']);
    blocker.release();
    await Promise.all([running, ...waiting]);
    expect(order).toEqual(['running', 'first-1', 'repeat-1', 'repeat-2']);
  });

  it('refuses only the lane that is full, and frees the slot when a compare throws', async () => {
    const gate = createPasswordCompareGate(1, 1);
    const blocker = held();
    const running = gate.run('first', () => blocker.done.then(() => Promise.reject(new Error('compare failed'))));
    const waitingRepeat = gate.run('repeat', async () => 'repeat ran');
    expect(gate.isFull('repeat')).toBe(true);
    expect(gate.isFull('first')).toBe(false);
    await expect(gate.run('repeat', async () => 'never')).rejects.toBeInstanceOf(PasswordComparesSaturatedError);
    const waitingFirst = gate.run('first', async () => 'first ran');
    blocker.release();
    await expect(running).rejects.toThrow('compare failed');
    await expect(waitingFirst).resolves.toBe('first ran');
    await expect(waitingRepeat).resolves.toBe('repeat ran');
    expect(gate.isFull('repeat')).toBe(false);
    await expect(gate.run('repeat', async () => 'free again')).resolves.toBe('free again');
  });
});

describe('reported client address', () => {
  it('keys a public IPv4 address as itself and a public IPv6 address by its /64', () => {
    expect(reportedClientLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(reportedClientLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(reportedClientLimitKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(reportedClientLimitKey('2001:DB8:1:2::9')).toBe('2001:db8:1:2::/64');
  });

  it('never keys on a missing, private, loopback or carrier-NAT address', () => {
    for (const address of [undefined, '', '10.0.0.4', '127.0.0.1', '::1', 'fd12:3456::1', '100.64.0.1', 'fe80::1']) {
      expect(reportedClientLimitKey(address)).toBeNull();
    }
  });
});
