import { describe, expect, it } from 'vitest';

import { createExpoWebStartArgs } from '../lib/expo-web-start-command';

describe('createExpoWebStartArgs', () => {
  it('clears environment-sensitive transforms and uses the allocated port', () => {
    expect(createExpoWebStartArgs(8092)).toEqual([
      '--filter',
      '@boardsesh/mobile',
      'run',
      'start',
      '--web',
      '--no-dev',
      '--clear',
      '--port',
      '8092',
      '--host',
      'localhost',
    ]);
  });

  it('uses pnpm filter-before-run order without forwarding a separator', () => {
    const args = createExpoWebStartArgs(8092);
    expect(args.slice(0, 4)).toEqual(['--filter', '@boardsesh/mobile', 'run', 'start']);
    expect(args).not.toContain('--');
  });
});
