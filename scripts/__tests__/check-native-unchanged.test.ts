/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  authProtocolNativeImporters,
  isWebOnly,
  jsonAdditionViolations,
  NATIVE_CHANGE_ALLOWLIST,
  nativeChangeViolations,
} from '../check-native-unchanged';

// #7596 acceptance 7: the web lane changes nothing that ships to phones.
describe('check-native-unchanged', () => {
  it('treats .web files and their tests as browser-only', () => {
    expect(isWebOnly('packages/mobile/src/lib/auth-store.web.ts')).toBe(true);
    expect(isWebOnly('packages/mobile/src/lib/__tests__/auth-browser-access-token.web.test.ts')).toBe(true);
    expect(isWebOnly('packages/mobile/src/components/AuthFieldset.web.tsx')).toBe(true);
    expect(isWebOnly('packages/mobile/src/lib/auth-store.ts')).toBe(false);
    expect(isWebOnly('packages/mobile/src/lib/web.ts')).toBe(false);
  });

  it('refuses a native file, and passes .web files, other packages and allowlisted files', () => {
    expect(
      nativeChangeViolations(
        [
          'packages/mobile/src/lib/auth-store.web.ts',
          'packages/web/app/lib/auth/session.ts',
          'packages/shared/text-redaction/src/password-recovery.ts',
          'packages/mobile/src/lib/auth-store.ts',
          'packages/shared/queue/src/reducer.ts',
        ],
        [],
      ),
    ).toEqual([
      'packages/mobile/src/lib/auth-store.ts: ships to phones and is not on the allowlist',
      'packages/shared/queue/src/reducer.ts: ships to phones and is not on the allowlist',
    ]);
  });

  it('exempts auth-protocol only while no native file imports it', () => {
    const change = [
      'packages/shared/auth-protocol/src/web-session.ts',
      // The viewer marker (#7596): an auth-protocol subpath; its Expo web copy is a `.web` file.
      'packages/shared/auth-protocol/src/viewer-marker.ts',
      'packages/mobile/src/lib/viewer-marker.web.ts',
    ];
    expect(nativeChangeViolations(change, [])).toEqual([]);
    expect(nativeChangeViolations(change, ['packages/mobile/src/lib/sentry.ts'])).toEqual([
      'packages/shared/auth-protocol/src/web-session.ts: auth-protocol is imported by native code (packages/mobile/src/lib/sentry.ts)',
      'packages/shared/auth-protocol/src/viewer-marker.ts: auth-protocol is imported by native code (packages/mobile/src/lib/sentry.ts)',
    ]);
  });

  it('finds native importers of auth-protocol, ignoring .web files, tests and auth-protocol itself', () => {
    expect(
      authProtocolNativeImporters([
        { path: 'packages/mobile/src/lib/a.ts', text: "import { x } from '@boardsesh/auth-protocol/web-session';" },
        { path: 'packages/mobile/src/lib/b.web.ts', text: "import { x } from '@boardsesh/auth-protocol';" },
        { path: 'packages/mobile/src/lib/__tests__/c.test.ts', text: "import { x } from '@boardsesh/auth-protocol';" },
        { path: 'packages/shared/auth-protocol/src/index.ts', text: "export * from '@boardsesh/auth-protocol/x';" },
        { path: 'packages/shared/queue/src/d.ts', text: "import '@boardsesh/auth-protocol-other';" },
      ]),
    ).toEqual(['packages/mobile/src/lib/a.ts']);
  });

  it('lets an allowlisted locale file gain keys and refuses a removed or changed one', () => {
    const base = JSON.stringify({ errors: { default: 'Oops' }, title: 'Hi' });
    expect(
      jsonAdditionViolations(
        'a.json',
        base,
        JSON.stringify({ errors: { default: 'Oops', added: 'New' }, title: 'Hi' }),
      ),
    ).toEqual([]);
    expect(
      jsonAdditionViolations('a.json', base, JSON.stringify({ errors: { default: 'Changed' }, title: 'Hi' })),
    ).toEqual(['a.json: changes errors.default']);
    expect(jsonAdditionViolations('a.json', base, JSON.stringify({ errors: {} }))).toEqual([
      'a.json: removes errors.default',
      'a.json: removes title',
    ]);
  });

  it('gives every allowlist entry a reason', () => {
    for (const [path, reason] of Object.entries(NATIVE_CHANGE_ALLOWLIST)) {
      expect(path.startsWith('packages/mobile/') || path.startsWith('packages/shared/'), path).toBe(true);
      expect(reason.length, path).toBeGreaterThan(20);
    }
  });
});

describe('web-lane-native-unchanged.yml', () => {
  type Workflow = {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; steps: Array<{ run?: string; with?: Record<string, unknown> }> }>;
  };
  const workflow = parse(readFileSync('.github/workflows/web-lane-native-unchanged.yml', 'utf8')) as Workflow;

  it('runs the check on every web-lane pull request, with the merge base in the clone', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs['native-unchanged'];
    expect(job.if).toContain("startsWith(github.head_ref, 'feat/7596-')");
    expect(job.if).toContain("startsWith(github.head_ref, 'test/7596-')");
    expect(job.if).toContain("startsWith(github.head_ref, 'fix/7596-')");
    expect(job.steps[0]?.with?.['fetch-depth']).toBe(0);
    expect(job.steps.map((step) => step.run ?? '').join('\n')).toContain(
      'vp exec tsx scripts/check-native-unchanged.ts origin/main',
    );
  });
});
