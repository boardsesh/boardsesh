import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the robots.txt shipped to the root of app.boardsesh.com, and the one
// line in production-deploy.yml that puts it there.
//
// Both halves are load-bearing and neither is obvious from the other. Without
// the file, `_redirects`' SPA catch-all answers /robots.txt with the app shell
// and a crawler reads no rules; without the copy step, the file sits in the
// repo and never reaches the published export. That was the live state on
// 2026-09-11 — https://app.boardsesh.com/robots.txt returned index.html.

const robots = readFileSync(resolve(import.meta.dirname, '..', 'robots.txt'), 'utf8');

const WORKFLOW_PATH = resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'production-deploy.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

/** Directive lines only — blank lines and `#` comments carry no meaning here. */
function directives(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('deploy/app-subdomain/robots.txt', () => {
  it('closes the whole host to every crawler', () => {
    // Parsed rather than string-matched, so a stray `Allow:` added later fails
    // here instead of shipping.
    expect(directives(robots)).toEqual(['User-agent: *', 'Disallow: /']);
  });

  it('carves out no exception for any individual agent', () => {
    // A per-agent block would need its own `User-agent:` line. One group is the
    // whole policy: the export is a single static shell with no per-route Open
    // Graph tags, so there is nothing an unfurler could usefully read.
    const lines = directives(robots);
    expect(lines.filter((line) => line.toLowerCase().startsWith('user-agent:'))).toHaveLength(1);
    // Directives only: the file's own comment explains why Disallow beats
    // noindex here, and `Disallow` contains `allow`.
    expect(lines.filter((line) => line.toLowerCase().startsWith('allow:'))).toHaveLength(0);
  });

  it('is copied into the published export by deploy-app-web', () => {
    expect(workflow).toMatch(/cp deploy\/app-subdomain\/robots\.txt\s+"\$RUNNER_TEMP\/app-standalone\/robots\.txt"/);
  });
});
