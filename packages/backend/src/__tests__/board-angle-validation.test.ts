import { describe, expect, it } from 'vite-plus/test';
import {
  AddClimbToPlaylistInputSchema,
  AscentFeedInputSchema,
  AttachBetaLinkInputSchema,
  CheckMoonBoardClimbDuplicatesInputSchema,
  CreateBoardInputSchema,
  CreateProposalInputSchema,
  GetClimbProposalsInputSchema,
  SaveClimbInputSchema,
  SaveMoonBoardClimbInputSchema,
  SaveTickInputSchema,
  SetterOverrideInputSchema,
  SubmitAppFeedbackInputSchema,
  UpdateBoardInputSchema,
  UpdateClimbInputSchema,
  UpdateTickInputSchema,
} from '../validation/schemas';

type BoardAwareParser = {
  name: string;
  parse: (boardType: string, angle: number) => boolean;
};

const boardAwareParsers: BoardAwareParser[] = [
  {
    name: 'save tick',
    parse: (boardType, angle) =>
      SaveTickInputSchema.safeParse({
        boardType,
        climbUuid: 'climb-1',
        angle,
        isMirror: false,
        status: 'send',
        attemptCount: 1,
        isBenchmark: false,
        comment: '',
        climbedAt: '2026-01-01T00:00:00.000Z',
      }).success,
  },
  {
    name: 'attach beta link',
    parse: (boardType, angle) =>
      AttachBetaLinkInputSchema.safeParse({
        boardType,
        climbUuid: 'climb-1',
        link: 'https://www.instagram.com/reel/ABC123/',
        angle,
      }).success,
  },
  {
    name: 'save climb',
    parse: (boardType, angle) =>
      SaveClimbInputSchema.safeParse({
        boardType,
        layoutId: 1,
        name: 'Test climb',
        isDraft: false,
        frames: 'p1',
        angle,
      }).success,
  },
  {
    name: 'update climb',
    parse: (boardType, angle) => UpdateClimbInputSchema.safeParse({ uuid: 'climb-1', boardType, angle }).success,
  },
  {
    name: 'create board',
    parse: (boardType, angle) =>
      CreateBoardInputSchema.safeParse({
        boardType,
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Test board',
        angle,
      }).success,
  },
  {
    name: 'create proposal',
    parse: (boardType, angle) =>
      CreateProposalInputSchema.safeParse({
        climbUuid: 'climb-1',
        boardType,
        angle,
        type: 'grade',
        proposedValue: 'V5',
      }).success,
  },
  {
    name: 'setter override',
    parse: (boardType, angle) =>
      SetterOverrideInputSchema.safeParse({ climbUuid: 'climb-1', boardType, angle }).success,
  },
  {
    name: 'get climb proposals',
    parse: (boardType, angle) =>
      GetClimbProposalsInputSchema.safeParse({ climbUuid: 'climb-1', boardType, angle }).success,
  },
];

describe('board-aware angle validation', () => {
  it.each(boardAwareParsers)('$name accepts Grasshopper -5 and rejects it for other boards', ({ parse }) => {
    expect(parse('grasshopper', -5)).toBe(true);
    expect(parse('kilter', -5)).toBe(false);
    expect(parse('tension', -5)).toBe(false);
    expect(parse('moonboard', -5)).toBe(false);
  });

  it.each(boardAwareParsers)('$name preserves historically accepted non-negative angles', ({ parse }) => {
    expect(parse('kilter', 41)).toBe(true);
  });

  it('keeps MoonBoard-only catalogue paths nonnegative', () => {
    expect(
      SaveMoonBoardClimbInputSchema.safeParse({
        boardType: 'moonboard',
        layoutId: 1,
        name: 'MoonBoard climb',
        holds: { start: [], hand: [], finish: [] },
        angle: -5,
      }).success,
    ).toBe(false);
    expect(
      CheckMoonBoardClimbDuplicatesInputSchema.safeParse({
        layoutId: 1,
        angle: -5,
        climbs: [{ clientKey: 'one', holds: { start: [], hand: [], finish: [] } }],
      }).success,
    ).toBe(false);
  });

  it('lets lookup-backed writes defer -5 to their resolver guards', () => {
    expect(UpdateTickInputSchema.safeParse({ angle: -5 }).success).toBe(true);
    expect(
      UpdateBoardInputSchema.safeParse({
        boardUuid: '11111111-1111-4111-8111-111111111111',
        angle: -5,
      }).success,
    ).toBe(true);
    expect(
      AddClimbToPlaylistInputSchema.safeParse({ playlistId: 'playlist-1', climbUuid: 'climb-1', angle: -5 }).success,
    ).toBe(true);
  });

  it('allows -5 in mixed-board feeds and best-effort feedback diagnostics', () => {
    expect(AscentFeedInputSchema.safeParse({ minAngle: -5, maxAngle: -5 }).success).toBe(true);

    const feedback = SubmitAppFeedbackInputSchema.safeParse({
      platform: 'ios',
      source: 'shake-bug',
      comment: 'Grasshopper angle is wrong',
      angle: -5,
    });
    expect(feedback.success).toBe(true);
    if (feedback.success) expect(feedback.data.angle).toBe(-5);
  });
});
