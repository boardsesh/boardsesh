import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { z } from 'zod';

const domain = vi.hoisted(() => ({
  resolveGymForTool: vi.fn(),
  assertBoardInGym: vi.fn(),
  assertKioskInGym: vi.fn(),
  assertCommentInGym: vi.fn(),
  assertReportInGym: vi.fn(),
  executeGymDocument: vi.fn(),
  listManagedGyms: vi.fn(),
  listLinkableBoards: vi.fn(),
  assertGymActionPermission: vi.fn(),
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
