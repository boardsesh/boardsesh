import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/refresh-acknowledgements.yml'),
  'utf8',
);

function stepBlock(stepName: string): string {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  const nextStep = workflow.indexOf('\n      - name: ', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return workflow.slice(start, nextStep >= 0 ? nextStep : workflow.length);
}

describe('refresh acknowledgements workflow', () => {
  it('mints the scoped Repository App token before checkout and refreshes strictly', () => {
    const credentialCheck = stepBlock('Require repository App credentials');
    const mintToken = stepBlock('Mint repository App token');
    const checkout = stepBlock('Checkout main');
    const regenerate = stepBlock('Regenerate acknowledgements + OSS licenses');
    const refreshStart = workflow.indexOf('\n  refresh:\n');
    const notifyStart = workflow.indexOf('\n  notify:\n');
    const refresh = workflow.slice(refreshStart, notifyStart);

    expect(refreshStart).toBeGreaterThanOrEqual(0);
    expect(notifyStart).toBeGreaterThan(refreshStart);
    expect(refresh).toContain('environment: Production');
    expect(credentialCheck).toContain('OTA_PUSH_APP_ID');
    expect(credentialCheck).toContain('OTA_PUSH_APP_PRIVATE_KEY');
    expect(workflow.indexOf(mintToken)).toBeLessThan(workflow.indexOf(checkout));
    expect(mintToken).toContain('actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
    expect(mintToken).toContain('permission-contents: write');
    expect(mintToken).toContain('permission-members: read');
    expect(checkout).toContain('token: ${{ steps.repository_app.outputs.token }}');
    expect(regenerate).toContain('GH_TOKEN: ${{ steps.repository_app.outputs.token }}');
    expect(regenerate).toContain('scripts/fetch-acknowledgements.ts --strict');
    expect(workflow).not.toContain('ACKNOWLEDGEMENTS_GH_TOKEN');
  });

  it('retries the App-backed protected-main commit rather than leaving a stale snapshot', () => {
    const commit = stepBlock('Commit refreshed data');

    expect(commit).toContain("git config user.name 'boardsesh-repo-bot[bot]'");
    expect(commit).toContain('for attempt in 1 2 3; do');
    expect(commit).toContain('git push origin HEAD:main');
    expect(commit).toContain('git rebase origin/main');
  });

  it('notifies the deployments channel after both successful and failed runs', () => {
    const notifyStart = workflow.indexOf('\n  notify:\n');
    const notify = workflow.slice(notifyStart);

    expect(notifyStart).toBeGreaterThanOrEqual(0);
    expect(notify).toContain('if: always()');
    expect(notify).toContain('environment: Production');
    expect(notify).toContain('DISCORD_DEPLOY_WEBHOOK');
    expect(notify).toContain('REFRESH_RESULT: ${{ needs.refresh.result }}');
    expect(notify).toContain('Acknowledgements refreshed');
    expect(notify).toContain('Acknowledgements refresh %s');
    expect(notify).toContain('allowed_mentions: {parse: []}');
  });
});
