import { expect, test } from 'vite-plus/test';
import { boardClimbs, boardClimbHolds } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { findExactDuplicateMatch } from '../graphql/resolvers/climbs/climb-similarity';

test('duplicate SQL distinguishes rule sets and Woods physical sizes', async () => {
  const cases = [
    { uuid: 'woods-default', boardType: 'woods', sizeId: 2, characteristics: [], description: '' },
    { uuid: 'woods-no-match', boardType: 'woods', sizeId: 2, characteristics: ['no_match'], description: '' },
    { uuid: 'woods-small', boardType: 'woods', sizeId: 1, characteristics: ['no_match'], description: '' },
    { uuid: 'aurora-legacy', boardType: 'kilter', sizeId: 2, characteristics: null, description: 'No matching hands' },
    { uuid: 'aurora-explicit', boardType: 'kilter', sizeId: 2, characteristics: [], description: 'No matching hands' },
  ];
  await db.insert(boardClimbs).values(
    cases.map((climb) => ({
      boardType: climb.boardType,
      uuid: climb.uuid,
      layoutId: 1,
      name: climb.uuid,
      frames: 'p0r4p1r3',
      framesCount: 1,
      angle: 40,
      isDraft: false,
      isListed: true,
      characteristics: climb.characteristics,
      description: climb.description,
      compatibleSizeIds: [climb.sizeId],
    })),
  );
  await db.insert(boardClimbHolds).values(
    cases.flatMap((climb) => [
      { boardType: climb.boardType, climbUuid: climb.uuid, frameNumber: 0, holdId: 0, holdState: 'STARTING' },
      { boardType: climb.boardType, climbUuid: climb.uuid, frameNumber: 0, holdId: 1, holdState: 'FINISH' },
    ]),
  );
  const signature = '0:STARTING,1:FINISH';
  for (const example of [
    { boardType: 'woods' as const, sizeId: 2, ruleSignature: '', expected: 'woods-default' },
    { boardType: 'woods' as const, sizeId: 2, ruleSignature: 'no_match', expected: 'woods-no-match' },
    { boardType: 'woods' as const, sizeId: 1, ruleSignature: 'no_match', expected: 'woods-small' },
    { boardType: 'kilter' as const, sizeId: undefined, ruleSignature: 'no_match', expected: 'aurora-legacy' },
    { boardType: 'kilter' as const, sizeId: undefined, ruleSignature: '', expected: 'aurora-explicit' },
  ]) {
    const match = await findExactDuplicateMatch({ ...example, layoutId: 1, signature });
    expect(match?.uuid).toBe(example.expected);
  }
  expect(
    await findExactDuplicateMatch({ boardType: 'woods', sizeId: 2, layoutId: 1, signature, ruleSignature: 'any_feet' }),
  ).toBeNull();
});
