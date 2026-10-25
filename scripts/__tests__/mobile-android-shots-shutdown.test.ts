import { describe, expect, it } from 'vitest';

import { parseSsListenerPids } from '../lib/metro-dev-server';
import { androidShotsReversePorts } from '../mobile-android-shots';

describe('androidShotsReversePorts', () => {
  it('reverses the local backend and web ports for --backend local', () => {
    expect(androidShotsReversePorts('local')).toEqual([8080, 3000]);
  });

  it('reverses nothing for prod', () => {
    expect(androidShotsReversePorts('prod')).toEqual([]);
  });
});

describe('parseSsListenerPids', () => {
  it('collects unique pids across lines', () => {
    const output = [
      'LISTEN 0 511 *:8097 *:* users:(("node",pid=1234,fd=23),("node",pid=1234,fd=24))',
      'LISTEN 0 511 0.0.0.0:19870 0.0.0.0:* users:(("node",pid=99,fd=20))',
    ].join('\n');
    expect(parseSsListenerPids(output)).toEqual([1234, 99]);
  });

  it('returns nothing for empty output', () => {
    expect(parseSsListenerPids('')).toEqual([]);
  });
});
