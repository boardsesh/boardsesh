import { describe, expect, it } from 'vitest';

import { decideSendRecovery, type SendRecoveryInput } from '../send-recovery-decision';

// Everything known, something to say, nothing in the way.
const READY: SendRecoveryInput = {
  ready: true,
  schemaReady: true,
  recoveredCount: 3,
  screenshotMode: false,
  launchedByDeepLink: false,
  topSegment: '(tabs)',
  onboardingSeen: true,
};

describe('decideSendRecovery', () => {
  it('shows the notice when sends were recovered and the app has settled', () => {
    expect(decideSendRecovery(READY)).toBe('show');
  });

  it('waits rather than guessing while anything is still unknown', () => {
    expect(decideSendRecovery({ ...READY, ready: false })).toBe('wait');
    // The recovery IS the migration, so before the schema lands there is no
    // answer — and reading "no note yet" as "nothing to say" would drop the
    // notice on a contended launch.
    expect(decideSendRecovery({ ...READY, schemaReady: false })).toBe('wait');
    expect(decideSendRecovery({ ...READY, recoveredCount: undefined })).toBe('wait');
    expect(decideSendRecovery({ ...READY, onboardingSeen: undefined })).toBe('wait');
  });

  it('says nothing at all when nothing was recovered', () => {
    // The requirement in its sharpest form: zero recovered sends is not a
    // quieter notice, it is silence. Almost every install lands here.
    expect(decideSendRecovery({ ...READY, recoveredCount: null })).toBe('none');
    expect(decideSendRecovery({ ...READY, recoveredCount: 0 })).toBe('none');
    expect(decideSendRecovery({ ...READY, recoveredCount: -1 })).toBe('none');
  });

  it('shows for a single recovered send', () => {
    expect(decideSendRecovery({ ...READY, recoveredCount: 1 })).toBe('show');
  });

  it('never fires on top of the first-run walkthrough', () => {
    expect(decideSendRecovery({ ...READY, onboardingSeen: false })).toBe('none');
    expect(decideSendRecovery({ ...READY, topSegment: 'onboarding' })).toBe('none');
  });

  it('yields to a deep link, by route and by launch URL', () => {
    expect(decideSendRecovery({ ...READY, topSegment: 'join' })).toBe('none');
    expect(decideSendRecovery({ ...READY, topSegment: 'session' })).toBe('none');
    expect(decideSendRecovery({ ...READY, topSegment: 'auth' })).toBe('none');
    // A custom-scheme link resolves INTO a tab, so the segment says '(tabs)'
    // and only the launch URL gives it away.
    expect(decideSendRecovery({ ...READY, launchedByDeepLink: true })).toBe('none');
  });

  it('does not push a second copy over itself', () => {
    expect(decideSendRecovery({ ...READY, topSegment: 'send-recovery' })).toBe('none');
  });

  it('stays out of App Store screenshots', () => {
    expect(decideSendRecovery({ ...READY, screenshotMode: true })).toBe('none');
  });
});
