import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decideSuperseded, tipFromLsRemote, triggerPathspecs } from '../push-run-superseded';

const REF = 'refs/heads/main';
const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);

describe('superseded push runs', () => {
  it('keeps the run that is still the branch tip', () => {
    expect(decideSuperseded({ ref: REF, sha: SHA, tip: SHA, changedTriggerPaths: [] }).superseded).toBe(false);
  });

  it('skips a run whose successor touched this workflow’s paths, because that push has its own run', () => {
    const decision = decideSuperseded({
      ref: REF,
      sha: SHA,
      tip: TIP,
      changedTriggerPaths: ['packages/mobile/app.config.ts'],
    });
    expect(decision.superseded).toBe(true);
    expect(decision.reason).toContain('packages/mobile/app.config.ts');
  });

  // The hole a plain "am I the tip?" check leaves open: a docs-only push moves the
  // tip without starting a run, and skipping here would leave the native change
  // in this commit unbuilt (or its JS unpublished) until some unrelated push.
  it('keeps a run whose successors only touched files outside its paths', () => {
    const decision = decideSuperseded({ ref: REF, sha: SHA, tip: TIP, changedTriggerPaths: [] });
    expect(decision.superseded).toBe(false);
    expect(decision.reason).toContain('no later run follows');
  });

  it('skips when the branch is gone', () => {
    expect(decideSuperseded({ ref: REF, sha: SHA, tip: null, changedTriggerPaths: [] }).superseded).toBe(true);
  });

  it('reads the exact ref from ls-remote output', () => {
    const listing = [`${TIP}\trefs/heads/other/release/next`, `${SHA}\t${REF}`, ''].join('\n');
    expect(tipFromLsRemote(listing, REF)).toBe(SHA);
    expect(tipFromLsRemote('', REF)).toBeNull();
    expect(tipFromLsRemote(`not-a-sha\t${REF}`, REF)).toBeNull();
  });

  it('turns push paths into glob pathspecs and refuses what it cannot mirror', () => {
    expect(
      triggerPathspecs("on:\n  push:\n    paths:\n      - 'packages/mobile/**'\n      - 'package.json'\n"),
    ).toEqual([':(glob)packages/mobile/**', ':(glob)package.json']);
    expect(() => triggerPathspecs("on:\n  push:\n    paths:\n      - '!docs/**'\n")).toThrow('negated');
    expect(() => triggerPathspecs('on:\n  workflow_dispatch:\n')).toThrow('no on.push trigger');
    expect(() => triggerPathspecs('on:\n  push:\n    paths-ignore: [docs/**]\n')).toThrow('paths-ignore');
  });

  it('compares every file for an unfiltered push, while production OTA has no direct push', () => {
    expect(triggerPathspecs('on:\n  push:\n    branches: [main]\n')).toEqual([]);
    expect(triggerPathspecs('on:\n  push:\n')).toEqual([]);
    expect(triggerPathspecs(readFileSync('.github/workflows/production-deploy.yml', 'utf8'))).toEqual([]);
    expect(() => triggerPathspecs(readFileSync('.github/workflows/mobile-ota-production.yml', 'utf8'))).toThrow(
      'no on.push trigger',
    );
  });

  it.each(['ios-testflight-rn.yml', 'android-apk-rn.yml'])('understands the push paths of %s', (name) => {
    const pathspecs = triggerPathspecs(readFileSync(`.github/workflows/${name}`, 'utf8'));
    expect(pathspecs).toContain(':(glob)packages/mobile/**');
    expect(pathspecs).toContain(`:(glob).github/workflows/${name}`);
  });
});
