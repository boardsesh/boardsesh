/**
 * The corpus here is real: every "written for the author" step is one this repo
 * actually shipped to testers, and every "written for the tester" step is one
 * from the same set of pull requests that must keep passing. A rule that
 * reddens a good plan costs more than the bad plans it catches.
 */

import { describe, expect, it } from 'vitest';
import { describeDeveloperVoice, findDeveloperVoice } from '../tester-voice';

// Shipped in the `## Test plan` of a merged PR, where a tester read it on a phone.
const WRITTEN_FOR_THE_AUTHOR: Array<[label: string, step: string]> = [
  ['a test runner', 'Run `vitest run scripts/__tests__/ci-runner-*.test.ts` → all pass.'],
  ['a doc to read', 'Read docs/production-deploy.md § "Where the images are built" → records the retirement.'],
  ['a header check', 'Run `curl -sI` on it. `x-sitemap-climbs-source: store` is present.'],
  ['a secrets CLI', 'Optional: `op run --env-file=packages/kilter-sync/.env.1password -- node …` prints credentials.'],
  ['a CI log step name', 'After merge: `build-web` log has no "Setup vp" step.'],
  ['a workspace script', 'Run `vp run typecheck:mobile` and confirm it is clean.'],
  ['a database probe', 'Run `SELECT count(*) FROM qa_verdicts` and see one new row.'],
  ['a source file', 'Check packages/mobile/src/lib/qa/qa-surf.ts uses the new key.'],
  ['a config file', 'app.config.ts still resolves the same fingerprint.'],
  ['a simulator build', 'Run `xcodebuild build -sdk iphonesimulator` — it succeeds.'],
];

// Shipped in the same window and read fine on a phone. None may be flagged.
const WRITTEN_FOR_THE_TESTER = [
  'CI green.',
  'Kilter board, signed in. Open any climb.',
  'Log a tick, pick a grade 3 harder. Save.',
  'Climbs → Create → pinch to zoom the board.',
  'Bottom right, under Save: tap the circle → board unzooms.',
  'Two phones, one session, one board. Phone A connects.',
  'Open https://updates.boardsesh.com/hc → loads blank, no error.',
  'Open /sitemaps/climbs/1.xml. XML loads with climb URLs.',
  'Android, dark theme → More. Section headers readable.',
  'Mobile app → force quit, reopen → an update downloads.',
  'Make a climb on the Woods board; the rules stay selected.',
  'Select your gym from the list; the map centres on it.',
  'Discord thread → mention Boardsesh Issues → 👀 appears.',
  'Sign out → sign-in screen. Field labels and typed text readable.',
  'A notice says how many off-board climbs were skipped.',
  // #4873, caught by an audit of every open PR before this rule shipped: a file
  // format a tester can see is not a command they have to run.
  'Back up profile → chosen cloud folder receives SQLite file.',
  'Install the EAS build from the link; it opens on the Boards tab.',
];

describe('findDeveloperVoice', () => {
  it.each(WRITTEN_FOR_THE_AUTHOR)('flags %s', (_label, step) => {
    expect(findDeveloperVoice(step)).not.toBeNull();
  });

  it.each(WRITTEN_FOR_THE_TESTER)('leaves a tester step alone: %s', (step) => {
    expect(findDeveloperVoice(step)).toBeNull();
  });

  it('separates a command from a repo path, so the message can say which', () => {
    expect(findDeveloperVoice('Run `vp check`')).toEqual({ kind: 'command', quote: 'vp' });
    expect(findDeveloperVoice('Open docs/db-migrations.md')).toEqual({
      kind: 'path',
      quote: 'docs/db-migrations.md',
    });
  });

  it('only reads an English word as a command where a command would go', () => {
    expect(findDeveloperVoice('Make a note, then reopen the app')).toBeNull();
    expect(findDeveloperVoice('Run `make build`')).toEqual({ kind: 'command', quote: 'make build' });
    expect(findDeveloperVoice('Run `eas update --branch production`')).toEqual({
      kind: 'command',
      quote: 'eas update --branch production',
    });
  });

  it('tells the author where the verification belongs', () => {
    const message = describeDeveloperVoice(2, { kind: 'command', quote: 'curl' });
    expect(message).toContain('Step 2');
    expect(message).toContain('curl');
    expect(message).toContain('Summary');
    expect(message).toContain('CI green.');
  });
});
