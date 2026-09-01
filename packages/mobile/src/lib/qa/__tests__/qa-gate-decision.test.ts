import { describe, expect, it } from 'vitest';
import { decideQaGate, QA_BLOCKED_TOP_SEGMENTS, type QaGateInput } from '../qa-gate-decision';

// A tester on production, everything resolved, two previews waiting — the one
// state that should actually prompt. Every test below names only what it changes.
function productionTester(overrides: Partial<QaGateInput> = {}): QaGateInput {
  return {
    ready: true,
    isTester: true,
    userId: 'user-a',
    surfingBuild: true,
    surfingReady: true,
    screenshotMode: false,
    launchedByDeepLink: false,
    topSegment: '(tabs)',
    onboardingSeen: true,
    runningPrNumber: null,
    prBranchCount: 2,
    briefSeenKey: null,
    verdictSubmittedKey: null,
    currentKey: null,
    ...overrides,
  };
}

// The same tester, already surfed onto pr-4792.
function previewTester(overrides: Partial<QaGateInput> = {}): QaGateInput {
  return productionTester({
    runningPrNumber: 4792,
    prBranchCount: null,
    currentKey: 'user-a:pr-4792:bundle-a',
    ...overrides,
  });
}

describe('decideQaGate — waiting', () => {
  it('waits until the app is ready', () => {
    expect(decideQaGate(productionTester({ ready: false }))).toBe('wait');
  });

  it('waits while the profile has not resolved', () => {
    // `isTester` is undefined on a cold offline start (the profile is
    // network-only). Reading that as "not a tester" would silently switch QA off
    // for everyone whose profile lands a second late.
    expect(decideQaGate(productionTester({ isTester: undefined }))).toBe('wait');
  });

  it('waits while the signed-in account is unknown', () => {
    // The markers are account-scoped and the settings store is device-wide, so a
    // marker read without an owner is a marker read for whoever used this device
    // last. `wait` — never "unseen".
    expect(decideQaGate(previewTester({ userId: undefined }))).toBe('wait');
  });

  it('waits while the onboarding flag has not been read', () => {
    expect(decideQaGate(productionTester({ onboardingSeen: undefined }))).toBe('wait');
  });

  it("waits while a surfing build's one-time migration is still settling", () => {
    // That migration ends in Updates.reloadAsync(); a route pushed before it
    // lands is thrown away by the reload.
    expect(decideQaGate(productionTester({ surfingReady: false }))).toBe('wait');
  });

  it('waits while the root layout has published nothing at all', () => {
    // `{ surfingBuild: false, surfingReady: false }` is the store's PRE-LAUNCH
    // state, not an answer. Reading it as "this build cannot surf" is a silent
    // kill switch: the gate marks the session decided on a `none` and never asks
    // again, so one reordering of the mount effects would switch QA off with
    // nothing said anywhere.
    expect(decideQaGate(productionTester({ surfingBuild: false, surfingReady: false }))).toBe('wait');
  });

  it('stops — not waits — once a non-surfing build has actually said so', () => {
    // Such a build publishes `{ false, true }` from its first effect
    // (`migrationComplete` starts at `!branchSurfingBuild`), so `ready` DOES
    // flip and the gate cannot hang on it.
    expect(decideQaGate(productionTester({ surfingBuild: false, surfingReady: true }))).toBe('none');
  });

  it('waits ahead of every other reason to stop', () => {
    // Order matters: a not-yet-known input must not be resolved as a decision
    // just because some later guard also happens to say "none".
    expect(decideQaGate(productionTester({ ready: false, isTester: false, screenshotMode: true }))).toBe('wait');
  });
});

describe('decideQaGate — reasons to stay quiet', () => {
  it('never prompts in screenshot mode', () => {
    expect(decideQaGate(productionTester({ screenshotMode: true }))).toBe('none');
  });

  it('never prompts a non-tester', () => {
    expect(decideQaGate(productionTester({ isTester: false }))).toBe('none');
  });

  it('never prompts on a build that cannot load a branch', () => {
    expect(decideQaGate(productionTester({ surfingBuild: false }))).toBe('none');
  });

  it('never prompts over a deep-link launch', () => {
    expect(decideQaGate(productionTester({ launchedByDeepLink: true }))).toBe('none');
  });

  it('never prompts before the first-run walkthrough has been seen', () => {
    expect(decideQaGate(productionTester({ onboardingSeen: false }))).toBe('none');
  });

  it.each([...QA_BLOCKED_TOP_SEGMENTS])('never prompts on the %s route group', (segment) => {
    expect(decideQaGate(productionTester({ topSegment: segment }))).toBe('none');
  });

  it('prompts on an unknown top segment', () => {
    // The block list is an allowlist inversion on purpose: a new tab group
    // should get the prompt, not silently opt out of QA.
    expect(decideQaGate(productionTester({ topSegment: 'new-tab-group' }))).toBe('pick');
  });

  it('prompts when there is no segment yet', () => {
    expect(decideQaGate(productionTester({ topSegment: undefined }))).toBe('pick');
  });
});

describe('decideQaGate — on production', () => {
  it('offers the pick list when there is something to test', () => {
    expect(decideQaGate(productionTester({ prBranchCount: 1 }))).toBe('pick');
  });

  it('stays quiet when nothing is published', () => {
    expect(decideQaGate(productionTester({ prBranchCount: 0 }))).toBe('none');
  });

  it('stays quiet when the branch list is unknown', () => {
    // null is "we never found out" — surfing off for this channel, or an
    // unreachable update server. Neither is a reason to show an empty list.
    expect(decideQaGate(productionTester({ prBranchCount: null }))).toBe('none');
  });
});

describe('decideQaGate — already on a preview', () => {
  it('shows the brief on the first launch of a surfed bundle', () => {
    expect(decideQaGate(previewTester())).toBe('brief');
  });

  it('does not show the brief twice for the same bundle', () => {
    expect(decideQaGate(previewTester({ briefSeenKey: 'user-a:pr-4792:bundle-a' }))).toBe('none');
  });

  it('shows the brief again after the author pushes a new bundle', () => {
    // Same branch, different updateId: a different thing to test.
    expect(
      decideQaGate(previewTester({ briefSeenKey: 'user-a:pr-4792:bundle-a', currentKey: 'user-a:pr-4792:bundle-b' })),
    ).toBe('brief');
  });

  it('stays quiet once a verdict has been filed for this bundle', () => {
    // Leaving a preview usually answers `nothing-to-load`, so the tester keeps
    // running it; without this they would be re-briefed on every launch.
    expect(decideQaGate(previewTester({ verdictSubmittedKey: 'user-a:pr-4792:bundle-a' }))).toBe('none');
  });

  it('re-briefs when the verdict was filed against an earlier bundle', () => {
    expect(
      decideQaGate(
        previewTester({ verdictSubmittedKey: 'user-a:pr-4792:bundle-a', currentKey: 'user-a:pr-4792:bundle-b' }),
      ),
    ).toBe('brief');
  });

  it('re-briefs a different tester on the same device and bundle', () => {
    // user-a signed pr-4792 off on this phone; user-b has still never seen it.
    expect(
      decideQaGate(
        previewTester({
          userId: 'user-b',
          currentKey: 'user-b:pr-4792:bundle-a',
          briefSeenKey: 'user-a:pr-4792:bundle-a',
          verdictSubmittedKey: 'user-a:pr-4792:bundle-a',
        }),
      ),
    ).toBe('brief');
  });

  it('ignores an unscoped marker left by a build before account scoping', () => {
    expect(decideQaGate(previewTester({ briefSeenKey: 'pr-4792:bundle-a' }))).toBe('brief');
  });

  it('ignores a stale marker from a different branch', () => {
    expect(
      decideQaGate(
        previewTester({ briefSeenKey: 'user-a:pr-1:bundle-a', verdictSubmittedKey: 'user-a:pr-2:bundle-a' }),
      ),
    ).toBe('brief');
  });

  it('prefers the brief over the pick list even when branches are listed', () => {
    expect(decideQaGate(previewTester({ prBranchCount: 5 }))).toBe('brief');
  });

  it('shows the brief when the session key could not be built', () => {
    // No updateId AND no branch marker is not a reason to hide what to test —
    // it just means the seen-markers cannot suppress it.
    expect(decideQaGate(previewTester({ currentKey: null, briefSeenKey: 'user-a:pr-4792:bundle-a' }))).toBe('brief');
  });
});
