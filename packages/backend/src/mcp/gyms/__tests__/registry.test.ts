import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext, GymGradeComparison } from '@boardsesh/shared-schema';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { buildBoardEmbedSnippet, buildLeaderboardEmbedSnippet } from '@boardsesh/kiosk';

const domain = vi.hoisted(() => ({
  resolveGymForTool: vi.fn(),
  assertBoardInGym: vi.fn(),
  assertKioskInGym: vi.fn(),
  assertCommentInGym: vi.fn(),
  assertReportInGym: vi.fn(),
  executeGymDocument: vi.fn(),
  listManagedGyms: vi.fn(),
  listLinkableBoards: vi.fn(),
  assertGymReplayPermission: vi.fn(),
  authorizeGymBoardRemoval: vi.fn(),
}));
vi.mock('../domain', () => domain);

import { buildGymSharingLinks, findGymMcpTool, gymMcpTools } from '../registry';

const gymUuid = '00000000-0000-4000-8000-000000000001';
const canonicalGymUuid = '00000000-0000-4000-8000-000000000002';
const boardUuid = '00000000-0000-4000-8000-000000000003';
const idempotencyKey = '00000000-0000-4000-8000-000000000004';
const context: ConnectionContext = {
  connectionId: 'test-gym-mcp',
  transport: 'http',
  userId: 'actor',
  isAuthenticated: true,
};

describe('gym MCP action registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    domain.resolveGymForTool.mockResolvedValue({
      id: 42,
      uuid: canonicalGymUuid,
      slug: 'crew',
      name: 'Crew gym',
      isPublic: true,
    });
    domain.executeGymDocument.mockResolvedValue({ saved: true });
  });

  it('covers all eight management tabs with unique explicit actions', () => {
    expect(new Set(gymMcpTools.map((tool) => tool.name)).size).toBe(gymMcpTools.length);
    for (const category of ['overview', 'profile', 'branding', 'boards', 'members', 'comments', 'kiosks', 'insights']) {
      expect(gymMcpTools.some((tool) => tool.category === category)).toBe(true);
    }
    expect(gymMcpTools.some((tool) => /graphql|execute|query/.test(tool.name))).toBe(false);
    for (const tool of gymMcpTools.filter((entry) => !entry.readOnly)) {
      expect(tool.inputSchema.shape.idempotencyKey).toBeDefined();
    }
  });

  it('requires a separate access scope for every staff mutation', () => {
    for (const name of ['grant_gym_edit_access', 'revoke_gym_edit_access', 'remove_gym_member']) {
      expect(findGymMcpTool(name)?.scope).toBe('gyms:access:write');
    }
  });

  it('exposes grade comparison and collection controls with read/write scopes', () => {
    for (const name of ['get_gym_grade_comparison', 'list_gym_grade_collections']) {
      expect(findGymMcpTool(name)).toMatchObject({ category: 'insights', scope: 'gyms:read', readOnly: true });
    }
    expect(findGymMcpTool('set_gym_grade_collection')).toMatchObject({
      category: 'insights',
      scope: 'gyms:write',
      readOnly: false,
      destructive: false,
    });
    const setter = findGymMcpTool('set_gym_grade_collection')!.inputSchema;
    expect(setter.safeParse({ gymUuid, boardUuid, playlistUuid: null }).success).toBe(false);
    expect(setter.safeParse({ gymUuid, boardUuid, idempotencyKey }).success).toBe(false);
    expect(setter.safeParse({ gymUuid, boardUuid, playlistUuid: null, idempotencyKey }).success).toBe(true);
    expect(setter.safeParse({ gymUuid, boardUuid, playlistUuid: 'x'.repeat(129), idempotencyKey }).success).toBe(false);
    expect(setter.safeParse({ gymUuid, boardUuid, playlistUuid: ' ', idempotencyKey }).success).toBe(false);
  });

  it('bounds grade collection search/cursors without exposing a caller-controlled page size', () => {
    const schema = findGymMcpTool('list_gym_grade_collections')!.inputSchema;
    expect(schema.parse({ gymUuid, boardUuid, search: '  crimp  ', cursor: '123' })).toMatchObject({
      search: 'crimp',
      cursor: '123',
    });
    expect(schema.safeParse({ gymUuid, boardUuid, search: 'x'.repeat(100), cursor: null }).success).toBe(true);
    expect(schema.safeParse({ gymUuid, boardUuid, search: 'x'.repeat(101) }).success).toBe(false);
    for (const cursor of ['0', '01', '-1', '1.2', '1e3', '1'.repeat(19)]) {
      expect(schema.safeParse({ gymUuid, boardUuid, cursor }).success).toBe(false);
    }
    expect(schema.safeParse({ gymUuid, boardUuid, limit: 1000 }).success).toBe(false);
  });

  it.each([
    {
      name: 'get_gym_grade_comparison',
      document: 'getGradeComparison',
      arguments_: { gymUuid, boardUuid, period: 'month' },
      input: { gymUuid: canonicalGymUuid, boardUuid, period: 'month' },
      write: false,
    },
    {
      name: 'list_gym_grade_collections',
      document: 'getGradeCollectionOptions',
      arguments_: { gymUuid, boardUuid, search: 'crimp', cursor: '123' },
      input: { gymUuid: canonicalGymUuid, boardUuid, search: 'crimp', cursor: '123' },
      write: false,
    },
    {
      name: 'set_gym_grade_collection',
      document: 'setGradeCollection',
      arguments_: { gymUuid, boardUuid, playlistUuid: null, idempotencyKey },
      input: { gymUuid: canonicalGymUuid, boardUuid, playlistUuid: null },
      write: true,
    },
  ])('canonicalizes the gym and binds the board for $name', async ({ name, document, arguments_, input, write }) => {
    await findGymMcpTool(name)!.run(arguments_, context);
    expect(domain.resolveGymForTool).toHaveBeenCalledWith(gymUuid, 'actor', true, write);
    expect(domain.assertBoardInGym).toHaveBeenCalledWith(boardUuid, 42, 'actor', false);
    expect(domain.executeGymDocument).toHaveBeenCalledWith(document, { input }, context);
  });

  it.each(['get_gym_grade_comparison', 'list_gym_grade_collections', 'set_gym_grade_collection'])(
    'refuses an out-of-gym board before executing %s',
    async (name) => {
      domain.assertBoardInGym.mockRejectedValueOnce(
        new GraphQLError('The gym or item is unavailable.', { extensions: { code: 'NOT_FOUND' } }),
      );
      const arguments_ =
        name === 'set_gym_grade_collection'
          ? { gymUuid, boardUuid, playlistUuid: null, idempotencyKey }
          : { gymUuid, boardUuid };
      await expect(findGymMcpTool(name)!.run(arguments_, context)).rejects.toMatchObject({
        extensions: { code: 'NOT_FOUND' },
      });
      expect(domain.executeGymDocument).not.toHaveBeenCalled();
    },
  );

  it('keeps grade comparison inclusion states and ungraded counts, including all-board reads', async () => {
    const comparison: GymGradeComparison = {
      gymUuid: canonicalGymUuid,
      asOf: '2026-11-24T10:00:00Z',
      startAt: '2026-11-17T10:00:00Z',
      timeZone: 'Europe/Amsterdam',
      availableCount: 2,
      sendCount: 1,
      grades: [{ boardType: 'kilter', difficultyId: null, availableCount: 2, sendCount: 1 }],
      boards: [
        {
          boardUuid,
          physicalBoardUuid: boardUuid,
          boardName: 'Wall',
          kind: 'LED_COLLECTION',
          status: 'COLLECTION_UNAVAILABLE',
          included: false,
          variantCount: 0,
          collectionName: null,
        },
      ],
    };
    domain.executeGymDocument.mockResolvedValueOnce({ gymGradeComparison: comparison });
    await expect(findGymMcpTool('get_gym_grade_comparison')!.run({ gymUuid }, context)).resolves.toEqual({
      gymGradeComparison: comparison,
    });
    expect(domain.assertBoardInGym).not.toHaveBeenCalled();
    expect(domain.executeGymDocument).toHaveBeenCalledWith(
      'getGradeComparison',
      {
        input: { gymUuid: canonicalGymUuid, boardUuid: undefined, period: 'week' },
      },
      context,
    );
  });

  it('delegates private collection visibility and selection rejection to the existing backend', async () => {
    const options = {
      gymGradeCollectionOptions: {
        collections: [{ uuid: 'visible-private-collection', name: 'My private comparison' }],
        nextCursor: '24',
      },
    };
    domain.executeGymDocument.mockResolvedValueOnce(options);
    await expect(findGymMcpTool('list_gym_grade_collections')!.run({ gymUuid, boardUuid }, context)).resolves.toEqual(
      options,
    );
    domain.executeGymDocument.mockRejectedValueOnce(
      new GraphQLError('Comparison collection is unavailable', { extensions: { code: 'COLLECTION_UNAVAILABLE' } }),
    );
    await expect(
      findGymMcpTool('set_gym_grade_collection')!.run(
        {
          gymUuid,
          boardUuid,
          playlistUuid: 'another-persons-private-collection',
          idempotencyKey,
        },
        context,
      ),
    ).rejects.toMatchObject({ extensions: { code: 'COLLECTION_UNAVAILABLE' } });
    expect(domain.executeGymDocument).toHaveBeenLastCalledWith(
      'setGradeCollection',
      {
        input: { gymUuid: canonicalGymUuid, boardUuid, playlistUuid: 'another-persons-private-collection' },
      },
      context,
    );
  });

  it('can advertise every typed input schema to an MCP client', () => {
    for (const tool of gymMcpTools) {
      expect(() => z.toJSONSchema(tool.inputSchema, { io: 'input' }), tool.name).not.toThrow();
    }
  });

  it('rejects unknown arguments, missing delete confirmation and duplicate bypass without confirmation', () => {
    expect(findGymMcpTool('get_gym')?.inputSchema.safeParse({ gymUuid, query: '{users{email}}' }).success).toBe(false);
    expect(
      findGymMcpTool('delete_gym_board')?.inputSchema.safeParse({ gymUuid, boardUuid, idempotencyKey }).success,
    ).toBe(false);
    expect(
      findGymMcpTool('update_gym_board')?.inputSchema.safeParse({
        gymUuid,
        boardUuid,
        idempotencyKey,
        changes: { allowDuplicateConfig: true },
      }).success,
    ).toBe(false);
    expect(
      findGymMcpTool('attach_nearby_board_to_gym')?.inputSchema.safeParse({
        gymUuid,
        boardUuid,
        idempotencyKey,
        confirm: true,
      }).success,
    ).toBe(false);
  });

  it('uses the canonical gym and binds the child before any board action', async () => {
    await findGymMcpTool('update_gym_board')!.run(
      { gymUuid, boardUuid, idempotencyKey, changes: { name: 'New wall' } },
      context,
    );
    expect(domain.resolveGymForTool).toHaveBeenCalledWith(gymUuid, 'actor', true, true);
    expect(domain.assertBoardInGym).toHaveBeenCalledWith(boardUuid, 42, 'actor', false);
    expect(domain.executeGymDocument).toHaveBeenCalledWith(
      'updateBoard',
      { input: { boardUuid, name: 'New wall' } },
      context,
    );
  });

  it('prepares a write once and leaves first-execution action rights to its resolver', async () => {
    const tool = findGymMcpTool('update_gym_board')!;
    const prepared = await tool.authorize(
      { gymUuid, boardUuid, idempotencyKey, changes: { name: 'New wall' } },
      context,
      false,
    );
    expect(domain.executeGymDocument).not.toHaveBeenCalled();
    await prepared();
    expect(domain.resolveGymForTool).toHaveBeenCalledOnce();
    expect(domain.assertBoardInGym).toHaveBeenCalledOnce();
    expect(domain.assertGymReplayPermission).not.toHaveBeenCalled();
    expect(domain.executeGymDocument).toHaveBeenCalledOnce();
  });

  it('rechecks operation rights for a replay without executing its prepared write', async () => {
    await findGymMcpTool('delete_gym_board')!.authorize(
      { gymUuid, boardUuid, idempotencyKey, confirm: true },
      context,
      true,
    );
    expect(domain.assertBoardInGym).toHaveBeenCalledWith(boardUuid, 42, 'actor', true);
    expect(domain.assertGymReplayPermission).toHaveBeenCalledWith(
      'delete_gym_board',
      expect.objectContaining({ gymUuid: canonicalGymUuid }),
      expect.objectContaining({ id: 42 }),
      context,
    );
    expect(domain.executeGymDocument).not.toHaveBeenCalled();
  });

  it('selects grant authority before preparing a staff access change', async () => {
    await findGymMcpTool('grant_gym_edit_access')!.authorize(
      { gymUuid, userId: 'recipient', idempotencyKey },
      context,
      false,
    );
    expect(domain.resolveGymForTool).toHaveBeenCalledWith(gymUuid, 'actor', true, true, 'grant');
  });

  it('chooses the creator unlink once while preparing a board removal', async () => {
    domain.authorizeGymBoardRemoval.mockResolvedValue({ gym: { uuid: canonicalGymUuid }, ownBoard: true });
    const prepared = await findGymMcpTool('remove_board_from_gym')!.authorize(
      { gymUuid, boardUuid, idempotencyKey, confirm: true },
      context,
      false,
    );
    await prepared();
    expect(domain.authorizeGymBoardRemoval).toHaveBeenCalledOnce();
    expect(domain.executeGymDocument).toHaveBeenCalledWith(
      'linkBoard',
      { input: { boardUuid, gymUuid: null } },
      context,
    );
  });

  it('does not execute a cross-gym child action', async () => {
    domain.assertKioskInGym.mockRejectedValueOnce(new Error('The gym or item is unavailable.'));
    await expect(
      findGymMcpTool('delete_gym_kiosk')!.run(
        { gymUuid, kioskUuid: boardUuid, idempotencyKey, confirm: true },
        context,
      ),
    ).rejects.toThrow('unavailable');
    expect(domain.executeGymDocument).not.toHaveBeenCalled();
  });

  it('binds replies and comment votes to this gym', async () => {
    await findGymMcpTool('add_gym_comment')!.run(
      { gymUuid, parentCommentUuid: boardUuid, idempotencyKey, body: 'See you there' },
      context,
    );
    expect(domain.assertCommentInGym).toHaveBeenCalledWith(boardUuid, canonicalGymUuid, false);
    expect(domain.executeGymDocument).toHaveBeenCalledWith(
      'addComment',
      { input: { entityType: 'gym', entityId: canonicalGymUuid, body: 'See you there', parentCommentUuid: boardUuid } },
      context,
    );
  });

  it.each([false, true])(
    'refuses a gym-target or unreadable report before first execution or replay (%s)',
    async (replay) => {
      domain.assertReportInGym.mockRejectedValueOnce(
        new GraphQLError('The gym or item is unavailable.', { extensions: { code: 'NOT_FOUND' } }),
      );
      await expect(
        findGymMcpTool('keep_reported_gym_board')!.authorize(
          { gymUuid, reportUuid: boardUuid, idempotencyKey },
          context,
          replay,
        ),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
      expect(domain.assertReportInGym).toHaveBeenCalledWith(boardUuid, 42, 'actor');
      expect(domain.executeGymDocument).not.toHaveBeenCalled();
    },
  );

  it('describes post-commit claim email as requested, rather than already delivered', async () => {
    domain.executeGymDocument.mockResolvedValueOnce({
      requestGymClaim: { status: 'email_sent', email: 'staff@gym.example' },
    });
    await expect(
      findGymMcpTool('request_gym_claim')!.run({ gymUuid, idempotencyKey, claimEmail: 'staff@gym.example' }, context),
    ).resolves.toEqual({ requestGymClaim: { status: 'email_requested', email: 'staff@gym.example' } });
  });

  it('never offers a private board as a public embed, and escapes visible names', () => {
    const result = buildGymSharingLinks(
      { uuid: gymUuid, slug: 'crew', name: 'Crew "<gym>"', isPublic: true },
      [
        { uuid: boardUuid, name: 'Private', isPublic: false },
        { uuid: canonicalGymUuid, name: 'A "<wall>"', isPublic: true },
      ],
      [],
    );
    const embeds = result.boardEmbeds as Array<{ snippet: string }>;
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.snippet).toContain('&quot;&lt;wall&gt;&quot;');
    expect(embeds[0]?.snippet).toBe(
      buildBoardEmbedSnippet({
        siteOrigin: 'https://www.boardsesh.com',
        boardUuid: canonicalGymUuid,
        boardName: 'A "<wall>"',
      }),
    );
    expect(result.leaderboardEmbed).toBe(
      buildLeaderboardEmbedSnippet({ siteOrigin: 'https://www.boardsesh.com', gymUuid, gymName: 'Crew "<gym>"' }),
    );
    expect(JSON.stringify(result)).not.toContain(boardUuid);
    expect(
      buildGymSharingLinks({ uuid: gymUuid, slug: 'private', name: 'Private', isPublic: false }, [], []),
    ).toMatchObject({
      requiresSignIn: true,
      leaderboardEmbed: null,
      boardEmbeds: [],
      gymUrl: 'https://www.boardsesh.com/gym/private',
    });
  });
});
