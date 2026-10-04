import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

import { collectWorkflow, summarise } from './queue-report';

const timing = {
  created_at: '2026-10-03T10:00:00Z',
  started_at: '2026-10-03T10:05:00Z',
  completed_at: '2026-10-03T10:35:00Z',
  labels: ['ubuntu-latest'],
};

describe('collectWorkflow', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('counts timed-out runner time while keeping skipped and invalid jobs out of timings', () => {
    const jobs = [
      { ...timing, name: 'success', conclusion: 'success' },
      { ...timing, name: 'timed out', conclusion: 'timed_out' },
      { ...timing, name: 'skipped', conclusion: 'skipped' },
      { ...timing, name: 'unknown', conclusion: 'action_required' },
      { ...timing, name: 'missing start', conclusion: 'timed_out', started_at: null },
    ];
    execFileSyncMock.mockImplementation((_command, args) => {
      const apiPath = Array.isArray(args) ? String(args[1]) : '';
      return apiPath.includes('/jobs?') ? JSON.stringify([{ jobs }]) : '123\n';
    });

    const samples = collectWorkflow(
      { days: 7, repo: 'boardsesh/boardsesh', workflows: ['ci.yml'], perWorkflow: 40, json: false },
      'ci.yml',
      '2026-10-03',
    );
    const total = summarise('total', samples);

    expect(samples.map((sample) => sample.name)).toEqual(['success', 'timed out', 'skipped']);
    expect(total).toMatchObject({
      ran: 2,
      skipped: 1,
      medQ: 5,
      p90Q: 5,
      maxQ: 5,
      medDur: 30,
      p90Dur: 30,
      totalMin: 60,
    });
  });
});
