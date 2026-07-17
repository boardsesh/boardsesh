import { describe, expect, it } from 'vitest';

import { createExpoWebStartArgs } from '../lib/expo-web-start-command';

describe('createExpoWebStartArgs', () => {
  it('clears environment-sensitive transforms and uses the allocated port', () => {
    expect(createExpoWebStartArgs(8092)).toEqual([
      'run',
      '--filter=@boardsesh/mobile',
      'start',
      '--',
      '--web',
      '--no-dev',
      '--clear',
      '--port',
      '8092',
      '--host',
      'localhost',
    ]);
  });
});
