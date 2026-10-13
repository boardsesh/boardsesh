import { playlists } from '../schema/app/playlists';
import { Column, getTableName, is, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
type ViewerId = string | null | undefined;
type PrivacyResourceKind = 'board' | 'session';

export function approvedFollowerCondition(userIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  if (!viewerId) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM user_follows privacy_follow WHERE privacy_follow.follower_id = ${viewerId} AND privacy_follow.following_id = ${userIdColumn})`;
}
export function userActivityVisibilityCondition(userIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`COALESCE((${viewerId ?? null} = ${userIdColumn} OR (NOT EXISTS (
    SELECT 1 FROM user_profiles privacy_profile WHERE privacy_profile.user_id = ${userIdColumn} AND privacy_profile.is_private = true
  )) OR ${approvedFollowerCondition(userIdColumn, viewerId)}), false)`;
}

export function contentVisibilityCondition(
  entityType: string | SQLWrapper,
  entityIdColumn: SQLWrapper,
  userIdColumn: SQLWrapper,
  viewerId: ViewerId,
): SQL {
  const approved = approvedFollowerCondition(userIdColumn, viewerId);
  // Social columns are enums; content_privacy also supports non-social text types.
  const entityTypeText = sql`${entityType}::text`;
  return sql`COALESCE(((${userIdColumn} IS NULL AND NOT EXISTS (SELECT 1 FROM content_privacy orphan_privacy WHERE orphan_privacy.entity_type = ${entityTypeText} AND orphan_privacy.entity_id = ${entityIdColumn})) OR ${viewerId ?? null} = ${userIdColumn} OR EXISTS (
    SELECT 1 FROM users privacy_owner
    LEFT JOIN user_profiles privacy_profile ON privacy_profile.user_id = privacy_owner.id
    LEFT JOIN content_privacy privacy_content ON privacy_content.entity_type = ${entityTypeText}
      AND privacy_content.entity_id = ${entityIdColumn} AND privacy_content.owner_id = privacy_owner.id
    WHERE privacy_owner.id = ${userIdColumn} AND CASE
      WHEN privacy_content.audience = 'only_me' THEN false
      WHEN privacy_content.audience = 'followers' THEN ${approved}
      WHEN NOT COALESCE(privacy_profile.is_private, false) THEN true
      WHEN privacy_content.audience = 'public' AND privacy_content.public_consent_revision = privacy_profile.privacy_revision THEN true
      ELSE ${approved} END
  )), false)`;
}

/**
 * The playlist uuid inside a `playlist_climb` entity id, or NULL when the id is
 * not that shape. The id is `<playlistUuid>:<climbUuid>`, or `<playlistUuid>:_all`
 * for the playlist's general thread; `validateEntityExists` (backend
 * `social/entity-validation.ts`) rejects any other shape before a comment or
 * vote is written, and the web and mobile playlist screens build it. A malformed
 * id names no playlist, so it grants nothing.
 */
export function playlistClimbEntityPlaylistUuid(entityIdColumn: SQLWrapper): SQL<string | null> {
  return sql<string | null>`CASE WHEN (${entityIdColumn})::text ~ '^[^:]+:[^:]+$'
    THEN split_part((${entityIdColumn})::text, ':', 1) ELSE NULL END`;
}

/** The climb uuid (or `_all`) inside a well-formed `playlist_climb` entity id, else NULL. */
export function playlistClimbEntityClimbUuid(entityIdColumn: SQLWrapper): SQL<string | null> {
  return sql<string | null>`CASE WHEN (${entityIdColumn})::text ~ '^[^:]+:[^:]+$'
    THEN split_part((${entityIdColumn})::text, ':', 2) ELSE NULL END`;
}

/**
 * Whether the viewer owns the item a comment, like or notification is about:
 * the tick's climber, the session's host, the climb's setter, the playlist's
 * owner, the comment's author, the board's or gym's owner. An owner sees every
 * comment and like on their own item, whatever the commenter's account privacy.
 * A deleted board or gym has no owner here, and an unknown entity type has none
 * at all.
 *
 * A proposal has no owner. It is moderation on someone else's climb: its
 * proposer reads other people's comments on it and hears about its votes and
 * outcome by the same account rule as everyone else: a private moderator, voter
 * or later reporter is named to them only if they follow that account.
 *
 * The entity type is compared as text: social columns are enums, and callers
 * also pass the non-social types `content_privacy` covers (which own nothing).
 */
export function entityOwnerCondition(
  entityType: string | SQLWrapper,
  entityIdColumn: SQLWrapper,
  viewerId: ViewerId,
): SQL<boolean> {
  if (!viewerId) return sql<boolean>`false`;
  return sql<boolean>`COALESCE(CASE (${entityType})::text
    WHEN 'tick' THEN EXISTS (SELECT 1 FROM boardsesh_ticks owner_tick
      WHERE owner_tick.uuid = ${entityIdColumn} AND owner_tick.user_id = ${viewerId})
    WHEN 'session' THEN EXISTS (SELECT 1 FROM board_sessions owner_session
      WHERE owner_session.id = ${entityIdColumn} AND owner_session.created_by_user_id = ${viewerId})
    WHEN 'climb' THEN EXISTS (SELECT 1 FROM board_climbs owner_climb
      WHERE owner_climb.uuid = ${entityIdColumn} AND owner_climb.user_id = ${viewerId})
    WHEN 'playlist_climb' THEN EXISTS (SELECT 1 FROM playlists owner_playlist
      JOIN playlist_ownership owner_playlist_role ON owner_playlist_role.playlist_id = owner_playlist.id
      WHERE owner_playlist.uuid = ${playlistClimbEntityPlaylistUuid(entityIdColumn)}
        AND owner_playlist_role.user_id = ${viewerId} AND owner_playlist_role.role = 'owner')
    WHEN 'comment' THEN EXISTS (SELECT 1 FROM comments owner_comment
      WHERE owner_comment.uuid = ${entityIdColumn} AND owner_comment.user_id = ${viewerId})
    WHEN 'board' THEN EXISTS (SELECT 1 FROM user_boards owner_board
      WHERE owner_board.uuid = ${entityIdColumn} AND owner_board.owner_id = ${viewerId}
        AND owner_board.deleted_at IS NULL)
    WHEN 'gym' THEN EXISTS (SELECT 1 FROM gyms owner_gym
      WHERE owner_gym.uuid = ${entityIdColumn} AND owner_gym.owner_id = ${viewerId}
        AND owner_gym.deleted_at IS NULL)
    ELSE false END, false)`;
}

export function resourceAccessCondition(
  kind: PrivacyResourceKind,
  resourceIdColumn: SQLWrapper,
  viewerId: ViewerId,
  options: {
    allowUnlistedLink?: boolean;
    /**
     * With `allowUnlistedLink: false`, still treat an unlisted resource as open
     * where this holds (a listing's "the viewer is already in it"), in the same
     * single lookup rather than a second access check.
     */
    unlistedWhen?: SQL;
  } = {},
): SQL {
  const source =
    kind === 'board'
      ? sql`SELECT privacy_board.uuid AS id, privacy_board.owner_id AS owner_id,
      CASE WHEN privacy_board.owner_id = '00000000-0000-0000-0000-000000000000' THEN 'public' WHEN privacy_board.is_unlisted THEN 'unlisted' WHEN privacy_board.is_public THEN 'public' ELSE 'only_me' END AS audience
      FROM user_boards privacy_board WHERE privacy_board.deleted_at IS NULL`
      : sql`SELECT privacy_session.id AS id, privacy_session.created_by_user_id AS owner_id,
      CASE WHEN privacy_session.is_public THEN 'public' ELSE 'unlisted' END AS audience FROM board_sessions privacy_session`;
  const audienceIsPublic =
    options.allowUnlistedLink === false
      ? options.unlistedWhen
        ? sql`(COALESCE(privacy_override.audience, privacy_resource.audience) = 'public'
          OR (COALESCE(privacy_override.audience, privacy_resource.audience) = 'unlisted' AND ${options.unlistedWhen}))`
        : sql`COALESCE(privacy_override.audience, privacy_resource.audience) = 'public'`
      : sql`COALESCE(privacy_override.audience, privacy_resource.audience) IN ('public', 'unlisted')`;
  const resourceCondition = sql`EXISTS (SELECT 1 FROM (${source}) privacy_resource
    LEFT JOIN resource_privacy privacy_override ON privacy_override.kind = ${kind} AND privacy_override.resource_id = privacy_resource.id
    LEFT JOIN resource_grants privacy_grant ON privacy_grant.kind = ${kind} AND privacy_grant.resource_id = privacy_resource.id AND privacy_grant.user_id = ${viewerId ?? null}
    WHERE privacy_resource.id = ${resourceIdColumn} AND (
      privacy_resource.owner_id = ${viewerId ?? null} OR (
        COALESCE(privacy_grant.status, 'pending') <> 'revoked' AND (
          ${audienceIsPublic} OR (
            COALESCE(privacy_override.audience, privacy_resource.audience) <> 'only_me' AND (
              privacy_grant.status = 'approved' OR ${kind === 'session' ? sql`(privacy_override.resource_id IS NULL AND EXISTS (SELECT 1 FROM board_session_participants legacy_participant WHERE legacy_participant.session_id = privacy_resource.id AND legacy_participant.user_id = ${viewerId ?? null}))` : sql`false`} OR (
                (COALESCE(privacy_override.audience, privacy_resource.audience) = 'followers' OR COALESCE(privacy_override.inherit_followers, false))
                AND ${approvedFollowerCondition(sql`privacy_resource.owner_id`, viewerId)}
              )
            )
          )
        )
      )
    ))`;
  return resourceCondition;
}

/**
 * Whether an item (a tick, a session card) may name the board it happened on:
 * its name, place, gym or distance. The item's own visibility follows its
 * author; this decides only the board fields on it. A log is not a link, so an
 * unlisted board is named only to people who already hold it, and a deleted or
 * unresolvable board is never named. Pass the item's author to keep their own
 * logbook naming every wall they climbed on.
 */
export function boardIdentityVisibleCondition(
  boardIdColumn: SQLWrapper,
  viewerId: ViewerId,
  authorIdColumn?: SQLWrapper,
): SQL<boolean> {
  const viewerIsAuthor = authorIdColumn && viewerId ? sql`${authorIdColumn} = ${viewerId} OR ` : sql``;
  return sql<boolean>`(${boardIdColumn} IS NOT NULL AND (${viewerIsAuthor}EXISTS (
    SELECT 1 FROM user_boards privacy_identity_board
    WHERE privacy_identity_board.id = ${boardIdColumn} AND privacy_identity_board.deleted_at IS NULL
      AND ${resourceAccessCondition('board', sql`privacy_identity_board.uuid`, viewerId, { allowUnlistedLink: false })}
  )))`;
}

/** Every current and legacy board a session names, for location redaction. */
function sessionBoardReferences(sessionIdColumn: SQLWrapper): SQL {
  // Match the shared board-path parsers: repeated/leading slashes and an optional
  // two-letter locale are accepted. Legacy path-only sessions still name a wall.
  const pathSource = sql`SELECT privacy_path_source.id,
    regexp_replace(regexp_replace(trim(both '/' from privacy_path_source.board_path), '/+', '/', 'g'), '^[a-z]{2}/', '') AS path
    FROM board_sessions privacy_path_source`;
  return sql`(
      SELECT privacy_parent_session.board_id FROM board_sessions privacy_parent_session
      WHERE privacy_parent_session.id = ${sessionIdColumn} AND privacy_parent_session.board_id IS NOT NULL
      UNION SELECT privacy_parent_membership.board_id FROM session_boards privacy_parent_membership
      WHERE privacy_parent_membership.session_id = ${sessionIdColumn}
      UNION SELECT privacy_named_board.id FROM (${pathSource}) privacy_named_session
      LEFT JOIN user_boards privacy_named_board ON privacy_named_board.slug = split_part(privacy_named_session.path, '/', 2)
        AND privacy_named_board.deleted_at IS NULL
      WHERE privacy_named_session.id = ${sessionIdColumn} AND split_part(privacy_named_session.path, '/', 1) = 'b'
      UNION SELECT privacy_spray_board.id FROM (${pathSource}) privacy_spray_session
      LEFT JOIN spray_walls privacy_spray_wall ON privacy_spray_wall.layout_id = CASE
        WHEN split_part(privacy_spray_session.path, '/', 2) ~ '^[0-9]{1,18}$'
        THEN split_part(privacy_spray_session.path, '/', 2)::bigint ELSE NULL END
        AND privacy_spray_wall.deleted_at IS NULL
      LEFT JOIN user_boards privacy_spray_board ON privacy_spray_board.uuid = privacy_spray_wall.board_uuid
        AND privacy_spray_board.deleted_at IS NULL
      WHERE privacy_spray_session.id = ${sessionIdColumn} AND split_part(privacy_spray_session.path, '/', 1) = 'spray'
    )`;
}

/**
 * Distances and coordinates must respect every referenced board's location policy.
 * Only a live board that denies the viewer blocks: an unresolvable or soft-deleted
 * parent has no policy left to enforce, so it never hides the session's own place.
 * An admin-hidden spray wall withholds its sessions' place from everyone but its
 * owner, the same spray wall rule that hides the wall itself.
 */
export function sessionBoardLocationCondition(sessionIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${sessionBoardReferences(sessionIdColumn)} privacy_parent_refs
    JOIN user_boards privacy_parent_board ON privacy_parent_board.id = privacy_parent_refs.board_id
      AND privacy_parent_board.deleted_at IS NULL
    WHERE NOT ${resourceAccessCondition('board', sql`privacy_parent_board.uuid`, viewerId, { allowUnlistedLink: false })}
      OR NOT ${resourceLocationCondition(sql`privacy_parent_board.uuid`, viewerId)}
      OR EXISTS (SELECT 1 FROM spray_walls privacy_hidden_wall
        WHERE privacy_hidden_wall.board_uuid = privacy_parent_board.uuid
          AND privacy_hidden_wall.hidden_at IS NOT NULL
          AND privacy_parent_board.owner_id IS DISTINCT FROM ${viewerId ?? null})
  )`;
}

/**
 * The author's own action on one exact board: a tick there, or a lit climb that
 * passed the durable dwell gate (`board_climb_events`). Given a session column,
 * only an action in that session counts; a NULL session (a row that belongs to
 * no live session) accepts an action in any session. `alias` keeps the two
 * subqueries' table names unique where several of these nest in one query.
 */
function authorActedOnBoardCondition(
  authorIdColumn: SQLWrapper,
  boardIdSql: SQL,
  sessionIdColumn: SQLWrapper | undefined,
  alias: 'identity_author' | 'anon_own_action',
): SQL<boolean> {
  const tick = sql.raw(`${alias}_tick`);
  const event = sql.raw(`${alias}_event`);
  const inSession = (table: SQL) =>
    sessionIdColumn ? sql`AND (${sessionIdColumn} IS NULL OR ${table}.session_id = ${sessionIdColumn})` : sql``;
  return sql<boolean>`(EXISTS (SELECT 1 FROM boardsesh_ticks ${tick}
      WHERE ${tick}.board_id = ${boardIdSql} AND ${tick}.user_id = ${authorIdColumn} ${inSession(tick)})
    OR EXISTS (SELECT 1 FROM board_climb_events ${event}
      WHERE ${event}.board_id = ${boardIdSql} AND ${event}.user_id = ${authorIdColumn} ${inSession(event)}))`;
}

/** Names inside a restricted board may be shared with its current approved members. */
export function restrictedBoardMemberIdentityCondition(
  authorIdColumn: SQLWrapper,
  boardIdColumn: SQLWrapper,
  viewerId: ViewerId,
  sessionIdColumn?: SQLWrapper,
): SQL<boolean> {
  if (!viewerId) return sql<boolean>`false`;
  return sql<boolean>`EXISTS (SELECT 1 FROM user_boards identity_member_board
    LEFT JOIN resource_privacy identity_member_policy ON identity_member_policy.kind = 'board'
      AND identity_member_policy.resource_id = identity_member_board.uuid
    WHERE identity_member_board.id = (${boardIdColumn})::bigint AND identity_member_board.deleted_at IS NULL
      AND COALESCE(identity_member_policy.audience, CASE
        WHEN identity_member_board.owner_id = '00000000-0000-0000-0000-000000000000' THEN 'public'
        WHEN identity_member_board.is_unlisted THEN 'unlisted'
        WHEN identity_member_board.is_public THEN 'public' ELSE 'only_me' END) IN ('only_me', 'followers', 'invite_only')
      AND (identity_member_board.owner_id = ${viewerId} OR EXISTS (
        SELECT 1 FROM resource_grants identity_member_grant WHERE identity_member_grant.kind = 'board'
          AND identity_member_grant.resource_id = identity_member_board.uuid
          AND identity_member_grant.user_id = ${viewerId} AND identity_member_grant.status = 'approved'))
      AND ${resourceAccessCondition('board', sql`identity_member_board.uuid`, viewerId, { allowUnlistedLink: false })}
      AND ${authorActedOnBoardCondition(authorIdColumn, sql`identity_member_board.id`, sessionIdColumn, 'identity_author')})`;
}

/**
 * Whether a climber shows as anonymous on a board-facing row (wall feed,
 * presence stats, leaderboard, live roster, Bluetooth holder) projected for
 * `boardIdColumn`: they chose to stay anonymous on boards they don't own, they
 * don't own this one, and the viewer is not them. Read-time only, so it is
 * retroactive and reversible: rows and counts keep the climber. It fails
 * closed: a board that no longer exists, a board the app made only to climb on
 * someone else's wall (`is_owned = false`), or none at all (a live session
 * nothing places on a board yet), is not theirs. Never NULL, so `NOT` of it is
 * safe.
 *
 * In a live session (`sessionIdColumn`) owning the board is not enough: any
 * member can move a session onto someone's public board. The owner is named
 * there only after their own tick or durable lit climb on that board in that
 * session, the same evidence the restricted-board member exception asks for.
 */
export function anonymousOnBoardCondition(
  authorIdColumn: SQLWrapper,
  boardIdColumn: SQLWrapper,
  viewerId: ViewerId,
  sessionIdColumn?: SQLWrapper,
): SQL<boolean> {
  const ownActionInSession = sessionIdColumn
    ? sql`AND (${sessionIdColumn} IS NULL OR ${authorActedOnBoardCondition(authorIdColumn, sql`anon_own_board.id`, sessionIdColumn, 'anon_own_action')})`
    : sql``;
  return sql<boolean>`(${authorIdColumn} IS NOT NULL AND ${authorIdColumn} IS DISTINCT FROM ${viewerId ?? null}
    AND EXISTS (SELECT 1 FROM user_profiles anon_profile
      WHERE anon_profile.user_id = ${authorIdColumn} AND anon_profile.anonymous_on_foreign_boards)
    AND NOT ${restrictedBoardMemberIdentityCondition(authorIdColumn, boardIdColumn, viewerId, sessionIdColumn)}
    AND NOT EXISTS (SELECT 1 FROM user_boards anon_own_board
      WHERE anon_own_board.id = (${boardIdColumn})::bigint AND anon_own_board.owner_id = ${authorIdColumn}
        AND anon_own_board.is_owned AND anon_own_board.deleted_at IS NULL ${ownActionInSession}))`;
}

/** Separate location policy; knowledge of a board UUID alone cannot reveal its address. */
export function resourceLocationCondition(boardUuid: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`EXISTS (SELECT 1 FROM user_boards privacy_location_board
    LEFT JOIN resource_privacy privacy_location_override ON privacy_location_override.kind = 'board'
      AND privacy_location_override.resource_id = privacy_location_board.uuid
    LEFT JOIN resource_grants privacy_location_grant ON privacy_location_grant.kind = 'board'
      AND privacy_location_grant.resource_id = privacy_location_board.uuid AND privacy_location_grant.user_id = ${viewerId ?? null}
    WHERE privacy_location_board.uuid = ${boardUuid} AND privacy_location_board.deleted_at IS NULL
      AND (privacy_location_board.owner_id = ${viewerId ?? null} OR (
        ${resourceAccessCondition('board', sql`privacy_location_board.uuid`, viewerId)} AND CASE
          COALESCE(privacy_location_override.location_audience, CASE WHEN privacy_location_board.hide_location THEN 'only_me' ELSE 'public' END)
          WHEN 'public' THEN true
          WHEN 'followers' THEN ${approvedFollowerCondition(sql`privacy_location_board.owner_id`, viewerId)}
          WHEN 'members' THEN privacy_location_grant.status = 'approved'
          ELSE false END
      )))`;
}

/** Applies the authored climb policy to its stats, grades and other reference rows. */
export function climbReferenceVisibilityCondition(
  reference: { boardType: SQLWrapper; climbUuid: SQLWrapper },
  viewerId: ViewerId,
): SQL {
  return sql`EXISTS (SELECT 1 FROM board_climbs privacy_reference_climb
    WHERE privacy_reference_climb.board_type = ${reference.boardType} AND privacy_reference_climb.uuid = ${reference.climbUuid}
    AND ${contentVisibilityCondition('climb', sql`privacy_reference_climb.uuid`, sql`privacy_reference_climb.user_id`, viewerId)})`;
}

/** Public numeric aggregates retain private ticks; first-ascent names are a separate projection. */
export function privateSafeFirstAscentName(
  stats: { boardType: SQLWrapper; climbUuid: SQLWrapper; angle: SQLWrapper; username: SQLWrapper },
  viewerId: ViewerId,
): SQL<string | null> {
  // Drizzle strips Column table qualifiers inside a single-table SELECT list.
  // These columns are correlated into nested queries, so keep their scope.
  const qualify = (column: SQLWrapper): SQLWrapper =>
    is(column, Column) ? sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}` : column;
  const correlated = {
    boardType: qualify(stats.boardType),
    climbUuid: qualify(stats.climbUuid),
    angle: qualify(stats.angle),
    username: qualify(stats.username),
  };
  // A first ascent is its author's activity: the session or wall it happened on
  // never hides the name, only the author's account and the tick's own audience.
  const tickVisible = contentVisibilityCondition(
    'tick',
    sql`privacy_fa_tick.uuid`,
    sql`privacy_fa_tick.user_id`,
    viewerId,
  );
  // Never expose the stored Boardsesh FA string: it can outlive a deleted tick,
  // account restriction or profile rename while asynchronous recomputation runs.
  return sql<string | null>`CASE WHEN EXISTS (
    SELECT 1 FROM board_climbs privacy_fa_owned WHERE privacy_fa_owned.board_type = ${correlated.boardType}
      AND privacy_fa_owned.uuid = ${correlated.climbUuid}
      AND (privacy_fa_owned.user_id IS NOT NULL OR privacy_fa_owned.is_boardsesh_authored)
  ) THEN (
    SELECT CASE WHEN ${tickVisible} THEN COALESCE(privacy_fa_profile.display_name, privacy_fa_user.name) ELSE NULL END
    FROM boardsesh_ticks privacy_fa_tick
    JOIN users privacy_fa_user ON privacy_fa_user.id = privacy_fa_tick.user_id
    LEFT JOIN user_profiles privacy_fa_profile ON privacy_fa_profile.user_id = privacy_fa_tick.user_id
    WHERE privacy_fa_tick.board_type = ${correlated.boardType} AND privacy_fa_tick.climb_uuid = ${correlated.climbUuid}
      AND privacy_fa_tick.angle = ${correlated.angle} AND privacy_fa_tick.status IN ('flash', 'send')
      AND privacy_fa_tick.kilter_detached_at IS NULL
    ORDER BY privacy_fa_tick.climbed_at ASC, privacy_fa_tick.id ASC LIMIT 1
  ) ELSE ${correlated.username} END`;
}

/** Owner/member grants survive account changes; only-me content is owner-only. */
export function playlistVisibilityCondition(
  viewerId: string | null | undefined,
  playlist: { id: SQLWrapper; uuid: SQLWrapper; isPublic: SQLWrapper } = playlists,
): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM playlist_ownership privacy_member
      WHERE privacy_member.playlist_id = ${playlist.id} AND privacy_member.user_id = ${viewerId ?? null}
      AND (privacy_member.role = 'owner' OR NOT EXISTS (
        SELECT 1 FROM content_privacy private_item WHERE private_item.entity_type = 'playlist'
        AND private_item.entity_id = ${playlist.uuid} AND private_item.audience = 'only_me'
      )))
    OR EXISTS (SELECT 1 FROM playlist_ownership playlist_privacy_owner
      WHERE playlist_privacy_owner.playlist_id = ${playlist.id} AND playlist_privacy_owner.role = 'owner'
      AND (${playlist.isPublic} OR EXISTS (
        SELECT 1 FROM content_privacy shared_item WHERE shared_item.entity_type = 'playlist'
        AND shared_item.entity_id = ${playlist.uuid} AND shared_item.audience <> 'only_me'
      ))
      AND ${contentVisibilityCondition('playlist', playlist.uuid, sql`playlist_privacy_owner.user_id`, viewerId)}
    )
  )`;
}
export const playlistPrivacyCondition = playlistVisibilityCondition;
