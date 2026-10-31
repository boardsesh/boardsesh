import { describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { TFunction } from 'i18next';
import { formatCrewPutUp, resolveCrewPutUp } from '../crew-put-up-store';

const queuedByAlice: ClimbQueueItem = {
  uuid: 'queue-repeat',
  addedByUser: { id: 'account-alice', username: 'Alice' },
  climb: {
    uuid: 'climb-repeat',
    name: 'Crimp Ladder',
    setter_username: 'setter',
    frames: 'p1r12',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
};

describe('crew put-up notice', () => {
  it('uses only the supplied mover name and never infers one from queue authorship', () => {
    expect(resolveCrewPutUp(queuedByAlice, '  Sam  ')).toEqual({
      queueItemUuid: 'queue-repeat',
      climbName: 'Crimp Ladder',
      personName: 'Sam',
    });
    expect(resolveCrewPutUp(queuedByAlice)?.personName).toBeNull();
    expect(resolveCrewPutUp(queuedByAlice, '   ')?.personName).toBeNull();
    expect(resolveCrewPutUp(null, 'Sam')).toBeNull();
  });

  it('formats named and generic notices with separate catalog keys', () => {
    const translate = vi.fn((key: string) => key);
    const named = resolveCrewPutUp(queuedByAlice, 'Sam')!;
    const generic = resolveCrewPutUp(queuedByAlice)!;
    formatCrewPutUp(named, translate as unknown as TFunction<'session'>);
    expect(translate).toHaveBeenLastCalledWith('playView.wallControl.crewPutUpNamed', {
      person: 'Sam',
      climb: 'Crimp Ladder',
    });
    formatCrewPutUp(generic, translate as unknown as TFunction<'session'>);
    expect(translate).toHaveBeenLastCalledWith('playView.wallControl.crewPutUp', { climb: 'Crimp Ladder' });
  });
});
