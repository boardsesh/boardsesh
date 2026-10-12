import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

it('accepts only completed reads, not a captured but unfinished scope', async () => {
  const reads = await import('../privacy-read-proof');
  const scope = reads.capturePrivacyReadScope();
  expect(reads.completedPrivacyReadGeneration([scope])).toBeNull();
  const proof = reads.completePrivacyRead(scope);
  expect(reads.completedPrivacyReadGeneration([proof])).toBe(0);
});

it('rejects both completed and pending reads when privacy changes', async () => {
  const reads = await import('../privacy-read-proof');
  const privacy = await import('../privacy-cache');
  const scope = reads.capturePrivacyReadScope();
  const proof = reads.completePrivacyRead(scope);
  privacy.invalidatePrivacySnapshots();
  expect(reads.completePrivacyRead(scope)).toBeNull();
  expect(reads.completedPrivacyReadGeneration([proof])).toBeNull();
});

it('rejects hydrated proofs and mixed or unknown pages', async () => {
  const reads = await import('../privacy-read-proof');
  const proof = reads.completePrivacyRead(reads.capturePrivacyReadScope());
  expect(reads.completedPrivacyReadGeneration([JSON.parse(JSON.stringify(proof))])).toBeNull();
  expect(reads.completedPrivacyReadGeneration([proof, undefined])).toBeNull();
  expect(reads.completedPrivacyReadGeneration([])).toBeNull();
});

it('rejects an earlier runtime proof even when both runtimes begin at generation zero', async () => {
  const firstRuntime = await import('../privacy-read-proof');
  const proof = firstRuntime.completePrivacyRead(firstRuntime.capturePrivacyReadScope());
  expect(firstRuntime.completedPrivacyReadGeneration([proof])).toBe(0);
  vi.resetModules();
  const nextRuntime = await import('../privacy-read-proof');
  expect(nextRuntime.completedPrivacyReadGeneration([proof])).toBeNull();
  expect(
    nextRuntime.completedPrivacyReadGeneration([
      nextRuntime.completePrivacyRead(nextRuntime.capturePrivacyReadScope()),
    ]),
  ).toBe(0);
});
