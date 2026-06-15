/* eslint-disable */
import * as types from './graphql';
import { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
  '\n  query GetDeleteAccountInfo {\n    deleteAccountInfo {\n      publishedClimbCount\n    }\n  }\n': typeof types.GetDeleteAccountInfoDocument;
  '\n  mutation DeleteAccount($input: DeleteAccountInput!) {\n    deleteAccount(input: $input)\n  }\n': typeof types.DeleteAccountDocument;
  '\n  query GetBetaLinks($boardType: String!, $climbUuid: String!) {\n    betaLinks(boardType: $boardType, climbUuid: $climbUuid) {\n      climbUuid\n      link\n      foreignUsername\n      angle\n      thumbnail\n      isListed\n      createdAt\n      tickUuid\n      boardId\n    }\n  }\n': typeof types.GetBetaLinksDocument;
  '\n  mutation AttachBetaLink($input: AttachBetaLinkInput!) {\n    attachBetaLink(input: $input)\n  }\n': typeof types.AttachBetaLinkDocument;
  '\n  query GetRecentBetaLinks($limit: Int, $boardType: String) {\n    recentBetaLinks(limit: $limit, boardType: $boardType) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n': typeof types.GetRecentBetaLinksDocument;
  '\n  query GetUserBetaLinks($userId: String!, $limit: Int) {\n    userBetaLinks(userId: $userId, limit: $limit) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n': typeof types.GetUserBetaLinksDocument;
  '\n  query BetaLinkPreview($link: String!) {\n    betaLinkPreview(link: $link) {\n      link\n      thumbnail\n      username\n      caption\n    }\n  }\n': typeof types.BetaLinkPreviewDocument;
  '\n  query ClimbStatsHistory($boardName: String!, $climbUuid: ID!) {\n    climbStatsHistory(boardName: $boardName, climbUuid: $climbUuid) {\n      angle\n      ascensionistCount\n      qualityAverage\n      difficultyAverage\n      displayDifficulty\n      createdAt\n    }\n  }\n': typeof types.ClimbStatsHistoryDocument;
  '\n  query GetGlobalCommentFeed($input: GlobalCommentFeedInput) {\n    globalCommentFeed(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n      cursor\n    }\n  }\n': typeof types.GetGlobalCommentFeedDocument;
  '\n  query GetComments($input: CommentsInput!) {\n    comments(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetCommentsDocument;
  '\n  query GetVoteSummary($entityType: SocialEntityType!, $entityId: String!) {\n    voteSummary(entityType: $entityType, entityId: $entityId) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n': typeof types.GetVoteSummaryDocument;
  '\n  query GetBulkVoteSummaries($input: BulkVoteSummaryInput!) {\n    bulkVoteSummaries(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n': typeof types.GetBulkVoteSummariesDocument;
  '\n  mutation AddComment($input: AddCommentInput!) {\n    addComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n': typeof types.AddCommentDocument;
  '\n  mutation UpdateComment($input: UpdateCommentInput!) {\n    updateComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n': typeof types.UpdateCommentDocument;
  '\n  mutation DeleteComment($commentUuid: ID!) {\n    deleteComment(commentUuid: $commentUuid)\n  }\n': typeof types.DeleteCommentDocument;
  '\n  mutation Vote($input: VoteInput!) {\n    vote(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n': typeof types.VoteDocument;
  '\n  mutation CreateSession($input: CreateSessionInput!) {\n    createSession(input: $input) {\n      id\n      name\n      boardPath\n      goal\n      isPublic\n      isPermanent\n      color\n      startedAt\n    }\n  }\n': typeof types.CreateSessionDocument;
  '\n  query Favorites($boardName: String!, $climbUuids: [String!]!, $angle: Int!) {\n    favorites(boardName: $boardName, climbUuids: $climbUuids, angle: $angle)\n  }\n': typeof types.FavoritesDocument;
  '\n  mutation ToggleFavorite($input: ToggleFavoriteInput!) {\n    toggleFavorite(input: $input) {\n      favorited\n    }\n  }\n': typeof types.ToggleFavoriteDocument;
  '\n  query UserFavoritesCounts {\n    userFavoritesCounts {\n      boardName\n      count\n    }\n  }\n': typeof types.UserFavoritesCountsDocument;
  '\n  query UserActiveBoards {\n    userActiveBoards\n  }\n': typeof types.UserActiveBoardsDocument;
  '\n  query GetUserFavoriteClimbs($input: GetUserFavoriteClimbsInput!) {\n    userFavoriteClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetUserFavoriteClimbsDocument;
  '\n  mutation SubmitAppFeedback($input: SubmitAppFeedbackInput!) {\n    submitAppFeedback(input: $input)\n  }\n': typeof types.SubmitAppFeedbackDocument;
  '\n  query GetNewClimbFeed($input: NewClimbFeedInput!) {\n    newClimbFeed(input: $input) {\n      items {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetNewClimbFeedDocument;
  '\n  query GetMyNewClimbSubscriptions {\n    myNewClimbSubscriptions {\n      id\n      boardType\n      layoutId\n      createdAt\n    }\n  }\n': typeof types.GetMyNewClimbSubscriptionsDocument;
  '\n  mutation SubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    subscribeNewClimbs(input: $input)\n  }\n': typeof types.SubscribeNewClimbsDocument;
  '\n  mutation UnsubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    unsubscribeNewClimbs(input: $input)\n  }\n': typeof types.UnsubscribeNewClimbsDocument;
  '\n  subscription OnNewClimbCreated($boardType: String!, $layoutId: Int!) {\n    newClimbCreated(boardType: $boardType, layoutId: $layoutId) {\n      climb {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n    }\n  }\n': typeof types.OnNewClimbCreatedDocument;
  '\n  query CheckMoonBoardClimbDuplicates($input: CheckMoonBoardClimbDuplicatesInput!) {\n    checkMoonBoardClimbDuplicates(input: $input) {\n      clientKey\n      exists\n      existingClimbUuid\n      existingClimbName\n    }\n  }\n': typeof types.CheckMoonBoardClimbDuplicatesDocument;
  '\n  query SimilarClimbs($input: SimilarClimbsInput!) {\n    similarClimbs(input: $input) {\n      uuid\n      name\n      setterUsername\n      angle\n      layoutId\n      frames\n      difficultyName\n      qualityAverage\n      ascensionistCount\n      compatibleSizeIds\n      similarity\n      sharedHoldCount\n      candidateHoldCount\n      targetHoldCount\n    }\n  }\n': typeof types.SimilarClimbsDocument;
  '\n  mutation SaveClimb($input: SaveClimbInput!) {\n    saveClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n': typeof types.SaveClimbDocument;
  '\n  mutation SaveMoonBoardClimb($input: SaveMoonBoardClimbInput!) {\n    saveMoonBoardClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n': typeof types.SaveMoonBoardClimbDocument;
  '\n  mutation UpdateClimb($input: UpdateClimbInput!) {\n    updateClimb(input: $input) {\n      uuid\n      createdAt\n      publishedAt\n      isDraft\n    }\n  }\n': typeof types.UpdateClimbDocument;
  '\n  mutation DeleteDraftClimb($uuid: ID!, $boardType: String!) {\n    deleteDraftClimb(uuid: $uuid, boardType: $boardType)\n  }\n': typeof types.DeleteDraftClimbDocument;
  '\n  query GetNotifications($unreadOnly: Boolean, $limit: Int, $offset: Int) {\n    notifications(unreadOnly: $unreadOnly, limit: $limit, offset: $offset) {\n      notifications {\n        uuid\n        type\n        actorId\n        actorDisplayName\n        actorAvatarUrl\n        entityType\n        entityId\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n': typeof types.GetNotificationsDocument;
  '\n  query GetGroupedNotifications($limit: Int, $offset: Int) {\n    groupedNotifications(limit: $limit, offset: $offset) {\n      groups {\n        uuid\n        type\n        entityType\n        entityId\n        actorCount\n        actors {\n          id\n          displayName\n          avatarUrl\n        }\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        setterUsername\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n': typeof types.GetGroupedNotificationsDocument;
  '\n  query GetUnreadNotificationCount {\n    unreadNotificationCount\n  }\n': typeof types.GetUnreadNotificationCountDocument;
  '\n  mutation MarkNotificationRead($notificationUuid: ID!) {\n    markNotificationRead(notificationUuid: $notificationUuid)\n  }\n': typeof types.MarkNotificationReadDocument;
  '\n  mutation MarkGroupNotificationsRead($type: NotificationType!, $entityType: SocialEntityType, $entityId: String) {\n    markGroupNotificationsRead(type: $type, entityType: $entityType, entityId: $entityId)\n  }\n': typeof types.MarkGroupNotificationsReadDocument;
  '\n  mutation MarkAllNotificationsRead {\n    markAllNotificationsRead\n  }\n': typeof types.MarkAllNotificationsReadDocument;
  '\n  fragment PlaylistFields on Playlist {\n    id\n    uuid\n    boardType\n    layoutId\n    name\n    description\n    isPublic\n    color\n    icon\n    createdAt\n    updatedAt\n    lastAccessedAt\n    climbCount\n    userRole\n    followerCount\n    isFollowedByMe\n    isPinnedByMe\n  }\n': typeof types.PlaylistFieldsFragmentDoc;
  '\n  \n  query GetUserPlaylists($input: GetUserPlaylistsInput!) {\n    userPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n': typeof types.GetUserPlaylistsDocument;
  '\n  \n  query GetAllUserPlaylists($input: GetAllUserPlaylistsInput!) {\n    allUserPlaylists(input: $input) {\n      playlists {\n        ...PlaylistFields\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetAllUserPlaylistsDocument;
  '\n  \n  query GetMyPinnedPlaylists($input: GetMyPinnedPlaylistsInput!) {\n    myPinnedPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n': typeof types.GetMyPinnedPlaylistsDocument;
  '\n  mutation PinPlaylist($input: PinPlaylistInput!) {\n    pinPlaylist(input: $input)\n  }\n': typeof types.PinPlaylistDocument;
  '\n  mutation UnpinPlaylist($input: PinPlaylistInput!) {\n    unpinPlaylist(input: $input)\n  }\n': typeof types.UnpinPlaylistDocument;
  '\n  \n  query GetPlaylist($playlistId: ID!) {\n    playlist(playlistId: $playlistId) {\n      ...PlaylistFields\n    }\n  }\n': typeof types.GetPlaylistDocument;
  '\n  query GetPlaylistsForClimb($input: GetPlaylistsForClimbInput!) {\n    playlistsForClimb(input: $input)\n  }\n': typeof types.GetPlaylistsForClimbDocument;
  '\n  query GetPlaylistsForClimbs($input: GetPlaylistsForClimbsInput!) {\n    playlistsForClimbs(input: $input) {\n      climbUuid\n      playlistUuids\n    }\n  }\n': typeof types.GetPlaylistsForClimbsDocument;
  '\n  \n  mutation CreatePlaylist($input: CreatePlaylistInput!) {\n    createPlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n': typeof types.CreatePlaylistDocument;
  '\n  \n  mutation UpdatePlaylist($input: UpdatePlaylistInput!) {\n    updatePlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n': typeof types.UpdatePlaylistDocument;
  '\n  mutation DeletePlaylist($playlistId: ID!) {\n    deletePlaylist(playlistId: $playlistId)\n  }\n': typeof types.DeletePlaylistDocument;
  '\n  mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) {\n    addClimbToPlaylist(input: $input) {\n      id\n      playlistId\n      climbUuid\n      angle\n      position\n      addedAt\n    }\n  }\n': typeof types.AddClimbToPlaylistDocument;
  '\n  mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) {\n    removeClimbFromPlaylist(input: $input)\n  }\n': typeof types.RemoveClimbFromPlaylistDocument;
  '\n  mutation ReorderPlaylistClimb($input: ReorderPlaylistClimbInput!) {\n    reorderPlaylistClimb(input: $input)\n  }\n': typeof types.ReorderPlaylistClimbDocument;
  '\n  query GetPlaylistClimbs($input: GetPlaylistClimbsInput!) {\n    playlistClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetPlaylistClimbsDocument;
  '\n  query DiscoverPlaylists($input: DiscoverPlaylistsInput!) {\n    discoverPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        createdAt\n        updatedAt\n        climbCount\n        creatorId\n        creatorName\n        isGeneratedRecommendation\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.DiscoverPlaylistsDocument;
  '\n  query GetPlaylistCreators($input: GetPlaylistCreatorsInput!) {\n    playlistCreators(input: $input) {\n      userId\n      displayName\n      playlistCount\n    }\n  }\n': typeof types.GetPlaylistCreatorsDocument;
  '\n  mutation UpdatePlaylistLastAccessed($playlistId: ID!) {\n    updatePlaylistLastAccessed(playlistId: $playlistId)\n  }\n': typeof types.UpdatePlaylistLastAccessedDocument;
  '\n  query SearchPlaylists($input: SearchPlaylistsInput!) {\n    searchPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        climbCount\n        creatorId\n        creatorName\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.SearchPlaylistsDocument;
  '\n  mutation FollowPlaylist($input: FollowPlaylistInput!) {\n    followPlaylist(input: $input)\n  }\n': typeof types.FollowPlaylistDocument;
  '\n  mutation UnfollowPlaylist($input: FollowPlaylistInput!) {\n    unfollowPlaylist(input: $input)\n  }\n': typeof types.UnfollowPlaylistDocument;
  '\n  query GetSmartPlaylist($input: GetSmartPlaylistInput!) {\n    smartPlaylist(input: $input) {\n      meta {\n        type\n        userId\n        userName\n        userAvatar\n        climbCount\n      }\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetSmartPlaylistDocument;
  '\n  query GetMySmartPlaylistCounts {\n    mySmartPlaylistCounts {\n      type\n      count\n    }\n  }\n': typeof types.GetMySmartPlaylistCountsDocument;
  '\n  query GetClimbProposals($input: GetClimbProposalsInput!) {\n    climbProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetClimbProposalsDocument;
  '\n  query GetClimbCommunityStatus($climbUuid: String!, $boardType: String!, $angle: Int!) {\n    climbCommunityStatus(climbUuid: $climbUuid, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      outlierAnalysis {\n        isOutlier\n        currentGrade\n        neighborAverage\n        neighborCount\n        gradeDifference\n      }\n      updatedAt\n    }\n  }\n': typeof types.GetClimbCommunityStatusDocument;
  '\n  query GetBulkClimbCommunityStatus($climbUuids: [String!]!, $boardType: String!, $angle: Int!) {\n    bulkClimbCommunityStatus(climbUuids: $climbUuids, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      updatedAt\n    }\n  }\n': typeof types.GetBulkClimbCommunityStatusDocument;
  '\n  query BrowseProposals($input: BrowseProposalsInput!) {\n    browseProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.BrowseProposalsDocument;
  '\n  query GetClimbClassicStatus($climbUuid: String!, $boardType: String!) {\n    climbClassicStatus(climbUuid: $climbUuid, boardType: $boardType) {\n      climbUuid\n      boardType\n      isClassic\n      updatedAt\n    }\n  }\n': typeof types.GetClimbClassicStatusDocument;
  '\n  mutation CreateProposal($input: CreateProposalInput!) {\n    createProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n': typeof types.CreateProposalDocument;
  '\n  mutation VoteOnProposal($input: VoteOnProposalInput!) {\n    voteOnProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      resolvedAt\n      resolvedBy\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n': typeof types.VoteOnProposalDocument;
  '\n  mutation ResolveProposal($input: ResolveProposalInput!) {\n    resolveProposal(input: $input) {\n      uuid\n      status\n      resolvedAt\n      resolvedBy\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n': typeof types.ResolveProposalDocument;
  '\n  mutation DeleteProposal($input: DeleteProposalInput!) {\n    deleteProposal(input: $input)\n  }\n': typeof types.DeleteProposalDocument;
  '\n  mutation SetterOverrideCommunityStatus($input: SetterOverrideInput!) {\n    setterOverrideCommunityStatus(input: $input) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      updatedAt\n    }\n  }\n': typeof types.SetterOverrideCommunityStatusDocument;
  '\n  mutation FreezeClimb($input: FreezeClimbInput!) {\n    freezeClimb(input: $input)\n  }\n': typeof types.FreezeClimbDocument;
  '\n  query GetCommunityRoles($boardType: String) {\n    communityRoles(boardType: $boardType) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n': typeof types.GetCommunityRolesDocument;
  '\n  query GetMyRoles {\n    myRoles {\n      id\n      userId\n      role\n      boardType\n      createdAt\n    }\n  }\n': typeof types.GetMyRolesDocument;
  '\n  mutation GrantRole($input: GrantRoleInput!) {\n    grantRole(input: $input) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n': typeof types.GrantRoleDocument;
  '\n  mutation RevokeRole($input: RevokeRoleInput!) {\n    revokeRole(input: $input)\n  }\n': typeof types.RevokeRoleDocument;
  '\n  query GetCommunitySettings($scope: String!, $scopeKey: String!) {\n    communitySettings(scope: $scope, scopeKey: $scopeKey) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n': typeof types.GetCommunitySettingsDocument;
  '\n  mutation SetCommunitySettings($input: SetCommunitySettingInput!) {\n    setCommunitySettings(input: $input) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n': typeof types.SetCommunitySettingsDocument;
  '\n  fragment SessionSummaryFields on SessionSummary {\n    sessionId\n    totalSends\n    totalAttempts\n    gradeDistribution {\n      grade\n      count\n    }\n    hardestClimb {\n      climbUuid\n      climbName\n      grade\n    }\n    participants {\n      userId\n      displayName\n      avatarUrl\n      sends\n      attempts\n    }\n    startedAt\n    endedAt\n    durationMinutes\n    goal\n  }\n': typeof types.SessionSummaryFieldsFragmentDoc;
  '\n  \n  mutation EndSession($sessionId: ID!, $timezone: String) {\n    endSession(sessionId: $sessionId, timezone: $timezone) {\n      ...SessionSummaryFields\n    }\n  }\n': typeof types.EndSessionDocument;
  '\n  \n  query GetSessionSummary($sessionId: ID!) {\n    sessionSummary(sessionId: $sessionId) {\n      ...SessionSummaryFields\n    }\n  }\n': typeof types.GetSessionSummaryDocument;
  '\n  mutation FollowUser($input: FollowInput!) {\n    followUser(input: $input)\n  }\n': typeof types.FollowUserDocument;
  '\n  mutation UnfollowUser($input: FollowInput!) {\n    unfollowUser(input: $input)\n  }\n': typeof types.UnfollowUserDocument;
  '\n  query GetPublicProfile($userId: ID!) {\n    publicProfile(userId: $userId) {\n      id\n      displayName\n      avatarUrl\n      followerCount\n      followingCount\n      isFollowedByMe\n    }\n  }\n': typeof types.GetPublicProfileDocument;
  '\n  query GetFollowers($input: FollowListInput!) {\n    followers(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetFollowersDocument;
  '\n  query GetFollowing($input: FollowListInput!) {\n    following(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetFollowingDocument;
  '\n  query IsFollowing($userId: ID!) {\n    isFollowing(userId: $userId)\n  }\n': typeof types.IsFollowingDocument;
  '\n  query SearchUsers($input: SearchUsersInput!) {\n    searchUsers(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.SearchUsersDocument;
  '\n  query GetFollowingAscentsFeed($input: FollowingAscentsFeedInput) {\n    followingAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetFollowingAscentsFeedDocument;
  '\n  query GetGlobalAscentsFeed($input: FollowingAscentsFeedInput) {\n    globalAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetGlobalAscentsFeedDocument;
  '\n  query GetFollowingClimbAscents($input: FollowingClimbAscentsInput!) {\n    followingClimbAscents(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        comment\n        climbedAt\n        upvotes\n        downvotes\n        commentCount\n      }\n    }\n  }\n': typeof types.GetFollowingClimbAscentsDocument;
  '\n  mutation FollowSetter($input: FollowSetterInput!) {\n    followSetter(input: $input)\n  }\n': typeof types.FollowSetterDocument;
  '\n  mutation UnfollowSetter($input: FollowSetterInput!) {\n    unfollowSetter(input: $input)\n  }\n': typeof types.UnfollowSetterDocument;
  '\n  query GetSetterProfile($input: SetterProfileInput!) {\n    setterProfile(input: $input) {\n      username\n      climbCount\n      boardTypes\n      followerCount\n      isFollowedByMe\n      linkedUserId\n      linkedUserDisplayName\n      linkedUserAvatarUrl\n    }\n  }\n': typeof types.GetSetterProfileDocument;
  '\n  query GetSetterClimbsFull($input: SetterClimbsFullInput!) {\n    setterClimbsFull(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetSetterClimbsFullDocument;
  '\n  query GetUserClimbs($input: UserClimbsInput!) {\n    userClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetUserClimbsDocument;
  '\n  query SearchUsersAndSetters($input: SearchUsersInput!) {\n    searchUsersAndSetters(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        setter {\n          username\n          climbCount\n          boardTypes\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.SearchUsersAndSettersDocument;
  '\n  query GetTicks($input: GetTicksInput!) {\n    ticks(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      upvotes\n      downvotes\n      commentCount\n    }\n  }\n': typeof types.GetTicksDocument;
  '\n  query GetUserTicks($userId: ID!, $boardType: String!) {\n    userTicks(userId: $userId, boardType: $boardType) {\n      climbUuid\n      angle\n      status\n      attemptCount\n      difficulty\n      effectiveDifficulty\n      climbedAt\n      layoutId\n    }\n  }\n': typeof types.GetUserTicksDocument;
  '\n  mutation SaveTick($input: SaveTickInput!) {\n    saveTick(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      comment\n      climbedAt\n    }\n  }\n': typeof types.SaveTickDocument;
  '\n  mutation DeleteTick($uuid: ID!) {\n    deleteTick(uuid: $uuid)\n  }\n': typeof types.DeleteTickDocument;
  '\n  query GetUserAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userAscentsFeed(userId: $userId, input: $input) {\n      items {\n        uuid\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        boardId\n        boardDisplayName\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        consensusDifficulty\n        consensusDifficultyName\n        qualityAverage\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetUserAscentsFeedDocument;
  '\n  query GetUserGroupedAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userGroupedAscentsFeed(userId: $userId, input: $input) {\n      groups {\n        key\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        frames\n        difficultyName\n        isBenchmark\n        isNoMatch\n        date\n        flashCount\n        sendCount\n        attemptCount\n        bestQuality\n        latestComment\n        items {\n          uuid\n          climbUuid\n          climbName\n          setterUsername\n          boardType\n          layoutId\n          angle\n          isMirror\n          status\n          attemptCount\n          quality\n          difficulty\n          difficultyName\n          isBenchmark\n          isNoMatch\n          comment\n          climbedAt\n          frames\n        }\n      }\n      totalCount\n      hasMore\n    }\n  }\n': typeof types.GetUserGroupedAscentsFeedDocument;
  '\n  query GetUserProfileStats($userId: ID!) {\n    userProfileStats(userId: $userId) {\n      totalDistinctClimbs\n      layoutStats {\n        layoutKey\n        boardType\n        layoutId\n        distinctClimbCount\n        gradeCounts {\n          grade\n          count\n        }\n      }\n    }\n  }\n': typeof types.GetUserProfileStatsDocument;
  '\n  query GetUserClimbPercentile($userId: ID!) {\n    userClimbPercentile(userId: $userId) {\n      totalDistinctClimbs\n      percentile\n      totalActiveUsers\n    }\n  }\n': typeof types.GetUserClimbPercentileDocument;
  '\n  mutation UpdateTick($uuid: ID!, $input: UpdateTickInput!) {\n    updateTick(uuid: $uuid, input: $input) {\n      uuid\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      updatedAt\n    }\n  }\n': typeof types.UpdateTickDocument;
};
const documents: Documents = {
  '\n  query GetDeleteAccountInfo {\n    deleteAccountInfo {\n      publishedClimbCount\n    }\n  }\n':
    types.GetDeleteAccountInfoDocument,
  '\n  mutation DeleteAccount($input: DeleteAccountInput!) {\n    deleteAccount(input: $input)\n  }\n':
    types.DeleteAccountDocument,
  '\n  query GetBetaLinks($boardType: String!, $climbUuid: String!) {\n    betaLinks(boardType: $boardType, climbUuid: $climbUuid) {\n      climbUuid\n      link\n      foreignUsername\n      angle\n      thumbnail\n      isListed\n      createdAt\n      tickUuid\n      boardId\n    }\n  }\n':
    types.GetBetaLinksDocument,
  '\n  mutation AttachBetaLink($input: AttachBetaLinkInput!) {\n    attachBetaLink(input: $input)\n  }\n':
    types.AttachBetaLinkDocument,
  '\n  query GetRecentBetaLinks($limit: Int, $boardType: String) {\n    recentBetaLinks(limit: $limit, boardType: $boardType) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n':
    types.GetRecentBetaLinksDocument,
  '\n  query GetUserBetaLinks($userId: String!, $limit: Int) {\n    userBetaLinks(userId: $userId, limit: $limit) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n':
    types.GetUserBetaLinksDocument,
  '\n  query BetaLinkPreview($link: String!) {\n    betaLinkPreview(link: $link) {\n      link\n      thumbnail\n      username\n      caption\n    }\n  }\n':
    types.BetaLinkPreviewDocument,
  '\n  query ClimbStatsHistory($boardName: String!, $climbUuid: ID!) {\n    climbStatsHistory(boardName: $boardName, climbUuid: $climbUuid) {\n      angle\n      ascensionistCount\n      qualityAverage\n      difficultyAverage\n      displayDifficulty\n      createdAt\n    }\n  }\n':
    types.ClimbStatsHistoryDocument,
  '\n  query GetGlobalCommentFeed($input: GlobalCommentFeedInput) {\n    globalCommentFeed(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n      cursor\n    }\n  }\n':
    types.GetGlobalCommentFeedDocument,
  '\n  query GetComments($input: CommentsInput!) {\n    comments(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetCommentsDocument,
  '\n  query GetVoteSummary($entityType: SocialEntityType!, $entityId: String!) {\n    voteSummary(entityType: $entityType, entityId: $entityId) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n':
    types.GetVoteSummaryDocument,
  '\n  query GetBulkVoteSummaries($input: BulkVoteSummaryInput!) {\n    bulkVoteSummaries(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n':
    types.GetBulkVoteSummariesDocument,
  '\n  mutation AddComment($input: AddCommentInput!) {\n    addComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n':
    types.AddCommentDocument,
  '\n  mutation UpdateComment($input: UpdateCommentInput!) {\n    updateComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n':
    types.UpdateCommentDocument,
  '\n  mutation DeleteComment($commentUuid: ID!) {\n    deleteComment(commentUuid: $commentUuid)\n  }\n':
    types.DeleteCommentDocument,
  '\n  mutation Vote($input: VoteInput!) {\n    vote(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n':
    types.VoteDocument,
  '\n  mutation CreateSession($input: CreateSessionInput!) {\n    createSession(input: $input) {\n      id\n      name\n      boardPath\n      goal\n      isPublic\n      isPermanent\n      color\n      startedAt\n    }\n  }\n':
    types.CreateSessionDocument,
  '\n  query Favorites($boardName: String!, $climbUuids: [String!]!, $angle: Int!) {\n    favorites(boardName: $boardName, climbUuids: $climbUuids, angle: $angle)\n  }\n':
    types.FavoritesDocument,
  '\n  mutation ToggleFavorite($input: ToggleFavoriteInput!) {\n    toggleFavorite(input: $input) {\n      favorited\n    }\n  }\n':
    types.ToggleFavoriteDocument,
  '\n  query UserFavoritesCounts {\n    userFavoritesCounts {\n      boardName\n      count\n    }\n  }\n':
    types.UserFavoritesCountsDocument,
  '\n  query UserActiveBoards {\n    userActiveBoards\n  }\n': types.UserActiveBoardsDocument,
  '\n  query GetUserFavoriteClimbs($input: GetUserFavoriteClimbsInput!) {\n    userFavoriteClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetUserFavoriteClimbsDocument,
  '\n  mutation SubmitAppFeedback($input: SubmitAppFeedbackInput!) {\n    submitAppFeedback(input: $input)\n  }\n':
    types.SubmitAppFeedbackDocument,
  '\n  query GetNewClimbFeed($input: NewClimbFeedInput!) {\n    newClimbFeed(input: $input) {\n      items {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetNewClimbFeedDocument,
  '\n  query GetMyNewClimbSubscriptions {\n    myNewClimbSubscriptions {\n      id\n      boardType\n      layoutId\n      createdAt\n    }\n  }\n':
    types.GetMyNewClimbSubscriptionsDocument,
  '\n  mutation SubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    subscribeNewClimbs(input: $input)\n  }\n':
    types.SubscribeNewClimbsDocument,
  '\n  mutation UnsubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    unsubscribeNewClimbs(input: $input)\n  }\n':
    types.UnsubscribeNewClimbsDocument,
  '\n  subscription OnNewClimbCreated($boardType: String!, $layoutId: Int!) {\n    newClimbCreated(boardType: $boardType, layoutId: $layoutId) {\n      climb {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n    }\n  }\n':
    types.OnNewClimbCreatedDocument,
  '\n  query CheckMoonBoardClimbDuplicates($input: CheckMoonBoardClimbDuplicatesInput!) {\n    checkMoonBoardClimbDuplicates(input: $input) {\n      clientKey\n      exists\n      existingClimbUuid\n      existingClimbName\n    }\n  }\n':
    types.CheckMoonBoardClimbDuplicatesDocument,
  '\n  query SimilarClimbs($input: SimilarClimbsInput!) {\n    similarClimbs(input: $input) {\n      uuid\n      name\n      setterUsername\n      angle\n      layoutId\n      frames\n      difficultyName\n      qualityAverage\n      ascensionistCount\n      compatibleSizeIds\n      similarity\n      sharedHoldCount\n      candidateHoldCount\n      targetHoldCount\n    }\n  }\n':
    types.SimilarClimbsDocument,
  '\n  mutation SaveClimb($input: SaveClimbInput!) {\n    saveClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n':
    types.SaveClimbDocument,
  '\n  mutation SaveMoonBoardClimb($input: SaveMoonBoardClimbInput!) {\n    saveMoonBoardClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n':
    types.SaveMoonBoardClimbDocument,
  '\n  mutation UpdateClimb($input: UpdateClimbInput!) {\n    updateClimb(input: $input) {\n      uuid\n      createdAt\n      publishedAt\n      isDraft\n    }\n  }\n':
    types.UpdateClimbDocument,
  '\n  mutation DeleteDraftClimb($uuid: ID!, $boardType: String!) {\n    deleteDraftClimb(uuid: $uuid, boardType: $boardType)\n  }\n':
    types.DeleteDraftClimbDocument,
  '\n  query GetNotifications($unreadOnly: Boolean, $limit: Int, $offset: Int) {\n    notifications(unreadOnly: $unreadOnly, limit: $limit, offset: $offset) {\n      notifications {\n        uuid\n        type\n        actorId\n        actorDisplayName\n        actorAvatarUrl\n        entityType\n        entityId\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n':
    types.GetNotificationsDocument,
  '\n  query GetGroupedNotifications($limit: Int, $offset: Int) {\n    groupedNotifications(limit: $limit, offset: $offset) {\n      groups {\n        uuid\n        type\n        entityType\n        entityId\n        actorCount\n        actors {\n          id\n          displayName\n          avatarUrl\n        }\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        setterUsername\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n':
    types.GetGroupedNotificationsDocument,
  '\n  query GetUnreadNotificationCount {\n    unreadNotificationCount\n  }\n':
    types.GetUnreadNotificationCountDocument,
  '\n  mutation MarkNotificationRead($notificationUuid: ID!) {\n    markNotificationRead(notificationUuid: $notificationUuid)\n  }\n':
    types.MarkNotificationReadDocument,
  '\n  mutation MarkGroupNotificationsRead($type: NotificationType!, $entityType: SocialEntityType, $entityId: String) {\n    markGroupNotificationsRead(type: $type, entityType: $entityType, entityId: $entityId)\n  }\n':
    types.MarkGroupNotificationsReadDocument,
  '\n  mutation MarkAllNotificationsRead {\n    markAllNotificationsRead\n  }\n':
    types.MarkAllNotificationsReadDocument,
  '\n  fragment PlaylistFields on Playlist {\n    id\n    uuid\n    boardType\n    layoutId\n    name\n    description\n    isPublic\n    color\n    icon\n    createdAt\n    updatedAt\n    lastAccessedAt\n    climbCount\n    userRole\n    followerCount\n    isFollowedByMe\n    isPinnedByMe\n  }\n':
    types.PlaylistFieldsFragmentDoc,
  '\n  \n  query GetUserPlaylists($input: GetUserPlaylistsInput!) {\n    userPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n':
    types.GetUserPlaylistsDocument,
  '\n  \n  query GetAllUserPlaylists($input: GetAllUserPlaylistsInput!) {\n    allUserPlaylists(input: $input) {\n      playlists {\n        ...PlaylistFields\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetAllUserPlaylistsDocument,
  '\n  \n  query GetMyPinnedPlaylists($input: GetMyPinnedPlaylistsInput!) {\n    myPinnedPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n':
    types.GetMyPinnedPlaylistsDocument,
  '\n  mutation PinPlaylist($input: PinPlaylistInput!) {\n    pinPlaylist(input: $input)\n  }\n':
    types.PinPlaylistDocument,
  '\n  mutation UnpinPlaylist($input: PinPlaylistInput!) {\n    unpinPlaylist(input: $input)\n  }\n':
    types.UnpinPlaylistDocument,
  '\n  \n  query GetPlaylist($playlistId: ID!) {\n    playlist(playlistId: $playlistId) {\n      ...PlaylistFields\n    }\n  }\n':
    types.GetPlaylistDocument,
  '\n  query GetPlaylistsForClimb($input: GetPlaylistsForClimbInput!) {\n    playlistsForClimb(input: $input)\n  }\n':
    types.GetPlaylistsForClimbDocument,
  '\n  query GetPlaylistsForClimbs($input: GetPlaylistsForClimbsInput!) {\n    playlistsForClimbs(input: $input) {\n      climbUuid\n      playlistUuids\n    }\n  }\n':
    types.GetPlaylistsForClimbsDocument,
  '\n  \n  mutation CreatePlaylist($input: CreatePlaylistInput!) {\n    createPlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n':
    types.CreatePlaylistDocument,
  '\n  \n  mutation UpdatePlaylist($input: UpdatePlaylistInput!) {\n    updatePlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n':
    types.UpdatePlaylistDocument,
  '\n  mutation DeletePlaylist($playlistId: ID!) {\n    deletePlaylist(playlistId: $playlistId)\n  }\n':
    types.DeletePlaylistDocument,
  '\n  mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) {\n    addClimbToPlaylist(input: $input) {\n      id\n      playlistId\n      climbUuid\n      angle\n      position\n      addedAt\n    }\n  }\n':
    types.AddClimbToPlaylistDocument,
  '\n  mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) {\n    removeClimbFromPlaylist(input: $input)\n  }\n':
    types.RemoveClimbFromPlaylistDocument,
  '\n  mutation ReorderPlaylistClimb($input: ReorderPlaylistClimbInput!) {\n    reorderPlaylistClimb(input: $input)\n  }\n':
    types.ReorderPlaylistClimbDocument,
  '\n  query GetPlaylistClimbs($input: GetPlaylistClimbsInput!) {\n    playlistClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetPlaylistClimbsDocument,
  '\n  query DiscoverPlaylists($input: DiscoverPlaylistsInput!) {\n    discoverPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        createdAt\n        updatedAt\n        climbCount\n        creatorId\n        creatorName\n        isGeneratedRecommendation\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.DiscoverPlaylistsDocument,
  '\n  query GetPlaylistCreators($input: GetPlaylistCreatorsInput!) {\n    playlistCreators(input: $input) {\n      userId\n      displayName\n      playlistCount\n    }\n  }\n':
    types.GetPlaylistCreatorsDocument,
  '\n  mutation UpdatePlaylistLastAccessed($playlistId: ID!) {\n    updatePlaylistLastAccessed(playlistId: $playlistId)\n  }\n':
    types.UpdatePlaylistLastAccessedDocument,
  '\n  query SearchPlaylists($input: SearchPlaylistsInput!) {\n    searchPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        climbCount\n        creatorId\n        creatorName\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.SearchPlaylistsDocument,
  '\n  mutation FollowPlaylist($input: FollowPlaylistInput!) {\n    followPlaylist(input: $input)\n  }\n':
    types.FollowPlaylistDocument,
  '\n  mutation UnfollowPlaylist($input: FollowPlaylistInput!) {\n    unfollowPlaylist(input: $input)\n  }\n':
    types.UnfollowPlaylistDocument,
  '\n  query GetSmartPlaylist($input: GetSmartPlaylistInput!) {\n    smartPlaylist(input: $input) {\n      meta {\n        type\n        userId\n        userName\n        userAvatar\n        climbCount\n      }\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetSmartPlaylistDocument,
  '\n  query GetMySmartPlaylistCounts {\n    mySmartPlaylistCounts {\n      type\n      count\n    }\n  }\n':
    types.GetMySmartPlaylistCountsDocument,
  '\n  query GetClimbProposals($input: GetClimbProposalsInput!) {\n    climbProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetClimbProposalsDocument,
  '\n  query GetClimbCommunityStatus($climbUuid: String!, $boardType: String!, $angle: Int!) {\n    climbCommunityStatus(climbUuid: $climbUuid, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      outlierAnalysis {\n        isOutlier\n        currentGrade\n        neighborAverage\n        neighborCount\n        gradeDifference\n      }\n      updatedAt\n    }\n  }\n':
    types.GetClimbCommunityStatusDocument,
  '\n  query GetBulkClimbCommunityStatus($climbUuids: [String!]!, $boardType: String!, $angle: Int!) {\n    bulkClimbCommunityStatus(climbUuids: $climbUuids, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      updatedAt\n    }\n  }\n':
    types.GetBulkClimbCommunityStatusDocument,
  '\n  query BrowseProposals($input: BrowseProposalsInput!) {\n    browseProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.BrowseProposalsDocument,
  '\n  query GetClimbClassicStatus($climbUuid: String!, $boardType: String!) {\n    climbClassicStatus(climbUuid: $climbUuid, boardType: $boardType) {\n      climbUuid\n      boardType\n      isClassic\n      updatedAt\n    }\n  }\n':
    types.GetClimbClassicStatusDocument,
  '\n  mutation CreateProposal($input: CreateProposalInput!) {\n    createProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n':
    types.CreateProposalDocument,
  '\n  mutation VoteOnProposal($input: VoteOnProposalInput!) {\n    voteOnProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      resolvedAt\n      resolvedBy\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n':
    types.VoteOnProposalDocument,
  '\n  mutation ResolveProposal($input: ResolveProposalInput!) {\n    resolveProposal(input: $input) {\n      uuid\n      status\n      resolvedAt\n      resolvedBy\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n':
    types.ResolveProposalDocument,
  '\n  mutation DeleteProposal($input: DeleteProposalInput!) {\n    deleteProposal(input: $input)\n  }\n':
    types.DeleteProposalDocument,
  '\n  mutation SetterOverrideCommunityStatus($input: SetterOverrideInput!) {\n    setterOverrideCommunityStatus(input: $input) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      updatedAt\n    }\n  }\n':
    types.SetterOverrideCommunityStatusDocument,
  '\n  mutation FreezeClimb($input: FreezeClimbInput!) {\n    freezeClimb(input: $input)\n  }\n':
    types.FreezeClimbDocument,
  '\n  query GetCommunityRoles($boardType: String) {\n    communityRoles(boardType: $boardType) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n':
    types.GetCommunityRolesDocument,
  '\n  query GetMyRoles {\n    myRoles {\n      id\n      userId\n      role\n      boardType\n      createdAt\n    }\n  }\n':
    types.GetMyRolesDocument,
  '\n  mutation GrantRole($input: GrantRoleInput!) {\n    grantRole(input: $input) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n':
    types.GrantRoleDocument,
  '\n  mutation RevokeRole($input: RevokeRoleInput!) {\n    revokeRole(input: $input)\n  }\n': types.RevokeRoleDocument,
  '\n  query GetCommunitySettings($scope: String!, $scopeKey: String!) {\n    communitySettings(scope: $scope, scopeKey: $scopeKey) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n':
    types.GetCommunitySettingsDocument,
  '\n  mutation SetCommunitySettings($input: SetCommunitySettingInput!) {\n    setCommunitySettings(input: $input) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n':
    types.SetCommunitySettingsDocument,
  '\n  fragment SessionSummaryFields on SessionSummary {\n    sessionId\n    totalSends\n    totalAttempts\n    gradeDistribution {\n      grade\n      count\n    }\n    hardestClimb {\n      climbUuid\n      climbName\n      grade\n    }\n    participants {\n      userId\n      displayName\n      avatarUrl\n      sends\n      attempts\n    }\n    startedAt\n    endedAt\n    durationMinutes\n    goal\n  }\n':
    types.SessionSummaryFieldsFragmentDoc,
  '\n  \n  mutation EndSession($sessionId: ID!, $timezone: String) {\n    endSession(sessionId: $sessionId, timezone: $timezone) {\n      ...SessionSummaryFields\n    }\n  }\n':
    types.EndSessionDocument,
  '\n  \n  query GetSessionSummary($sessionId: ID!) {\n    sessionSummary(sessionId: $sessionId) {\n      ...SessionSummaryFields\n    }\n  }\n':
    types.GetSessionSummaryDocument,
  '\n  mutation FollowUser($input: FollowInput!) {\n    followUser(input: $input)\n  }\n': types.FollowUserDocument,
  '\n  mutation UnfollowUser($input: FollowInput!) {\n    unfollowUser(input: $input)\n  }\n':
    types.UnfollowUserDocument,
  '\n  query GetPublicProfile($userId: ID!) {\n    publicProfile(userId: $userId) {\n      id\n      displayName\n      avatarUrl\n      followerCount\n      followingCount\n      isFollowedByMe\n    }\n  }\n':
    types.GetPublicProfileDocument,
  '\n  query GetFollowers($input: FollowListInput!) {\n    followers(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetFollowersDocument,
  '\n  query GetFollowing($input: FollowListInput!) {\n    following(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetFollowingDocument,
  '\n  query IsFollowing($userId: ID!) {\n    isFollowing(userId: $userId)\n  }\n': types.IsFollowingDocument,
  '\n  query SearchUsers($input: SearchUsersInput!) {\n    searchUsers(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.SearchUsersDocument,
  '\n  query GetFollowingAscentsFeed($input: FollowingAscentsFeedInput) {\n    followingAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetFollowingAscentsFeedDocument,
  '\n  query GetGlobalAscentsFeed($input: FollowingAscentsFeedInput) {\n    globalAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetGlobalAscentsFeedDocument,
  '\n  query GetFollowingClimbAscents($input: FollowingClimbAscentsInput!) {\n    followingClimbAscents(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        comment\n        climbedAt\n        upvotes\n        downvotes\n        commentCount\n      }\n    }\n  }\n':
    types.GetFollowingClimbAscentsDocument,
  '\n  mutation FollowSetter($input: FollowSetterInput!) {\n    followSetter(input: $input)\n  }\n':
    types.FollowSetterDocument,
  '\n  mutation UnfollowSetter($input: FollowSetterInput!) {\n    unfollowSetter(input: $input)\n  }\n':
    types.UnfollowSetterDocument,
  '\n  query GetSetterProfile($input: SetterProfileInput!) {\n    setterProfile(input: $input) {\n      username\n      climbCount\n      boardTypes\n      followerCount\n      isFollowedByMe\n      linkedUserId\n      linkedUserDisplayName\n      linkedUserAvatarUrl\n    }\n  }\n':
    types.GetSetterProfileDocument,
  '\n  query GetSetterClimbsFull($input: SetterClimbsFullInput!) {\n    setterClimbsFull(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetSetterClimbsFullDocument,
  '\n  query GetUserClimbs($input: UserClimbsInput!) {\n    userClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetUserClimbsDocument,
  '\n  query SearchUsersAndSetters($input: SearchUsersInput!) {\n    searchUsersAndSetters(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        setter {\n          username\n          climbCount\n          boardTypes\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.SearchUsersAndSettersDocument,
  '\n  query GetTicks($input: GetTicksInput!) {\n    ticks(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      upvotes\n      downvotes\n      commentCount\n    }\n  }\n':
    types.GetTicksDocument,
  '\n  query GetUserTicks($userId: ID!, $boardType: String!) {\n    userTicks(userId: $userId, boardType: $boardType) {\n      climbUuid\n      angle\n      status\n      attemptCount\n      difficulty\n      effectiveDifficulty\n      climbedAt\n      layoutId\n    }\n  }\n':
    types.GetUserTicksDocument,
  '\n  mutation SaveTick($input: SaveTickInput!) {\n    saveTick(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      comment\n      climbedAt\n    }\n  }\n':
    types.SaveTickDocument,
  '\n  mutation DeleteTick($uuid: ID!) {\n    deleteTick(uuid: $uuid)\n  }\n': types.DeleteTickDocument,
  '\n  query GetUserAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userAscentsFeed(userId: $userId, input: $input) {\n      items {\n        uuid\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        boardId\n        boardDisplayName\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        consensusDifficulty\n        consensusDifficultyName\n        qualityAverage\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetUserAscentsFeedDocument,
  '\n  query GetUserGroupedAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userGroupedAscentsFeed(userId: $userId, input: $input) {\n      groups {\n        key\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        frames\n        difficultyName\n        isBenchmark\n        isNoMatch\n        date\n        flashCount\n        sendCount\n        attemptCount\n        bestQuality\n        latestComment\n        items {\n          uuid\n          climbUuid\n          climbName\n          setterUsername\n          boardType\n          layoutId\n          angle\n          isMirror\n          status\n          attemptCount\n          quality\n          difficulty\n          difficultyName\n          isBenchmark\n          isNoMatch\n          comment\n          climbedAt\n          frames\n        }\n      }\n      totalCount\n      hasMore\n    }\n  }\n':
    types.GetUserGroupedAscentsFeedDocument,
  '\n  query GetUserProfileStats($userId: ID!) {\n    userProfileStats(userId: $userId) {\n      totalDistinctClimbs\n      layoutStats {\n        layoutKey\n        boardType\n        layoutId\n        distinctClimbCount\n        gradeCounts {\n          grade\n          count\n        }\n      }\n    }\n  }\n':
    types.GetUserProfileStatsDocument,
  '\n  query GetUserClimbPercentile($userId: ID!) {\n    userClimbPercentile(userId: $userId) {\n      totalDistinctClimbs\n      percentile\n      totalActiveUsers\n    }\n  }\n':
    types.GetUserClimbPercentileDocument,
  '\n  mutation UpdateTick($uuid: ID!, $input: UpdateTickInput!) {\n    updateTick(uuid: $uuid, input: $input) {\n      uuid\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      updatedAt\n    }\n  }\n':
    types.UpdateTickDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = graphql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function graphql(source: string): unknown;

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetDeleteAccountInfo {\n    deleteAccountInfo {\n      publishedClimbCount\n    }\n  }\n',
): (typeof documents)['\n  query GetDeleteAccountInfo {\n    deleteAccountInfo {\n      publishedClimbCount\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation DeleteAccount($input: DeleteAccountInput!) {\n    deleteAccount(input: $input)\n  }\n',
): (typeof documents)['\n  mutation DeleteAccount($input: DeleteAccountInput!) {\n    deleteAccount(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetBetaLinks($boardType: String!, $climbUuid: String!) {\n    betaLinks(boardType: $boardType, climbUuid: $climbUuid) {\n      climbUuid\n      link\n      foreignUsername\n      angle\n      thumbnail\n      isListed\n      createdAt\n      tickUuid\n      boardId\n    }\n  }\n',
): (typeof documents)['\n  query GetBetaLinks($boardType: String!, $climbUuid: String!) {\n    betaLinks(boardType: $boardType, climbUuid: $climbUuid) {\n      climbUuid\n      link\n      foreignUsername\n      angle\n      thumbnail\n      isListed\n      createdAt\n      tickUuid\n      boardId\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation AttachBetaLink($input: AttachBetaLinkInput!) {\n    attachBetaLink(input: $input)\n  }\n',
): (typeof documents)['\n  mutation AttachBetaLink($input: AttachBetaLinkInput!) {\n    attachBetaLink(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetRecentBetaLinks($limit: Int, $boardType: String) {\n    recentBetaLinks(limit: $limit, boardType: $boardType) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n',
): (typeof documents)['\n  query GetRecentBetaLinks($limit: Int, $boardType: String) {\n    recentBetaLinks(limit: $limit, boardType: $boardType) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserBetaLinks($userId: String!, $limit: Int) {\n    userBetaLinks(userId: $userId, limit: $limit) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n',
): (typeof documents)['\n  query GetUserBetaLinks($userId: String!, $limit: Int) {\n    userBetaLinks(userId: $userId, limit: $limit) {\n      climbName\n      boardType\n      layoutId\n      betaLink {\n        climbUuid\n        link\n        foreignUsername\n        angle\n        thumbnail\n        isListed\n        createdAt\n        tickUuid\n        boardId\n      }\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query BetaLinkPreview($link: String!) {\n    betaLinkPreview(link: $link) {\n      link\n      thumbnail\n      username\n      caption\n    }\n  }\n',
): (typeof documents)['\n  query BetaLinkPreview($link: String!) {\n    betaLinkPreview(link: $link) {\n      link\n      thumbnail\n      username\n      caption\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query ClimbStatsHistory($boardName: String!, $climbUuid: ID!) {\n    climbStatsHistory(boardName: $boardName, climbUuid: $climbUuid) {\n      angle\n      ascensionistCount\n      qualityAverage\n      difficultyAverage\n      displayDifficulty\n      createdAt\n    }\n  }\n',
): (typeof documents)['\n  query ClimbStatsHistory($boardName: String!, $climbUuid: ID!) {\n    climbStatsHistory(boardName: $boardName, climbUuid: $climbUuid) {\n      angle\n      ascensionistCount\n      qualityAverage\n      difficultyAverage\n      displayDifficulty\n      createdAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetGlobalCommentFeed($input: GlobalCommentFeedInput) {\n    globalCommentFeed(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n      cursor\n    }\n  }\n',
): (typeof documents)['\n  query GetGlobalCommentFeed($input: GlobalCommentFeedInput) {\n    globalCommentFeed(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n      cursor\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetComments($input: CommentsInput!) {\n    comments(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetComments($input: CommentsInput!) {\n    comments(input: $input) {\n      comments {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        entityType\n        entityId\n        parentCommentUuid\n        body\n        isDeleted\n        replyCount\n        upvotes\n        downvotes\n        voteScore\n        userVote\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetVoteSummary($entityType: SocialEntityType!, $entityId: String!) {\n    voteSummary(entityType: $entityType, entityId: $entityId) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n',
): (typeof documents)['\n  query GetVoteSummary($entityType: SocialEntityType!, $entityId: String!) {\n    voteSummary(entityType: $entityType, entityId: $entityId) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetBulkVoteSummaries($input: BulkVoteSummaryInput!) {\n    bulkVoteSummaries(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n',
): (typeof documents)['\n  query GetBulkVoteSummaries($input: BulkVoteSummaryInput!) {\n    bulkVoteSummaries(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation AddComment($input: AddCommentInput!) {\n    addComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation AddComment($input: AddCommentInput!) {\n    addComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UpdateComment($input: UpdateCommentInput!) {\n    updateComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation UpdateComment($input: UpdateCommentInput!) {\n    updateComment(input: $input) {\n      uuid\n      userId\n      userDisplayName\n      userAvatarUrl\n      entityType\n      entityId\n      parentCommentUuid\n      body\n      isDeleted\n      replyCount\n      upvotes\n      downvotes\n      voteScore\n      userVote\n      createdAt\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation DeleteComment($commentUuid: ID!) {\n    deleteComment(commentUuid: $commentUuid)\n  }\n',
): (typeof documents)['\n  mutation DeleteComment($commentUuid: ID!) {\n    deleteComment(commentUuid: $commentUuid)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation Vote($input: VoteInput!) {\n    vote(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n',
): (typeof documents)['\n  mutation Vote($input: VoteInput!) {\n    vote(input: $input) {\n      entityType\n      entityId\n      upvotes\n      downvotes\n      voteScore\n      userVote\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation CreateSession($input: CreateSessionInput!) {\n    createSession(input: $input) {\n      id\n      name\n      boardPath\n      goal\n      isPublic\n      isPermanent\n      color\n      startedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation CreateSession($input: CreateSessionInput!) {\n    createSession(input: $input) {\n      id\n      name\n      boardPath\n      goal\n      isPublic\n      isPermanent\n      color\n      startedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query Favorites($boardName: String!, $climbUuids: [String!]!, $angle: Int!) {\n    favorites(boardName: $boardName, climbUuids: $climbUuids, angle: $angle)\n  }\n',
): (typeof documents)['\n  query Favorites($boardName: String!, $climbUuids: [String!]!, $angle: Int!) {\n    favorites(boardName: $boardName, climbUuids: $climbUuids, angle: $angle)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation ToggleFavorite($input: ToggleFavoriteInput!) {\n    toggleFavorite(input: $input) {\n      favorited\n    }\n  }\n',
): (typeof documents)['\n  mutation ToggleFavorite($input: ToggleFavoriteInput!) {\n    toggleFavorite(input: $input) {\n      favorited\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query UserFavoritesCounts {\n    userFavoritesCounts {\n      boardName\n      count\n    }\n  }\n',
): (typeof documents)['\n  query UserFavoritesCounts {\n    userFavoritesCounts {\n      boardName\n      count\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query UserActiveBoards {\n    userActiveBoards\n  }\n',
): (typeof documents)['\n  query UserActiveBoards {\n    userActiveBoards\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserFavoriteClimbs($input: GetUserFavoriteClimbsInput!) {\n    userFavoriteClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetUserFavoriteClimbs($input: GetUserFavoriteClimbsInput!) {\n    userFavoriteClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SubmitAppFeedback($input: SubmitAppFeedbackInput!) {\n    submitAppFeedback(input: $input)\n  }\n',
): (typeof documents)['\n  mutation SubmitAppFeedback($input: SubmitAppFeedbackInput!) {\n    submitAppFeedback(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetNewClimbFeed($input: NewClimbFeedInput!) {\n    newClimbFeed(input: $input) {\n      items {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetNewClimbFeed($input: NewClimbFeedInput!) {\n    newClimbFeed(input: $input) {\n      items {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetMyNewClimbSubscriptions {\n    myNewClimbSubscriptions {\n      id\n      boardType\n      layoutId\n      createdAt\n    }\n  }\n',
): (typeof documents)['\n  query GetMyNewClimbSubscriptions {\n    myNewClimbSubscriptions {\n      id\n      boardType\n      layoutId\n      createdAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    subscribeNewClimbs(input: $input)\n  }\n',
): (typeof documents)['\n  mutation SubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    subscribeNewClimbs(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UnsubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    unsubscribeNewClimbs(input: $input)\n  }\n',
): (typeof documents)['\n  mutation UnsubscribeNewClimbs($input: NewClimbSubscriptionInput!) {\n    unsubscribeNewClimbs(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  subscription OnNewClimbCreated($boardType: String!, $layoutId: Int!) {\n    newClimbCreated(boardType: $boardType, layoutId: $layoutId) {\n      climb {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n    }\n  }\n',
): (typeof documents)['\n  subscription OnNewClimbCreated($boardType: String!, $layoutId: Int!) {\n    newClimbCreated(boardType: $boardType, layoutId: $layoutId) {\n      climb {\n        uuid\n        name\n        boardType\n        layoutId\n        setterDisplayName\n        setterAvatarUrl\n        angle\n        frames\n        difficultyName\n        isNoMatch\n        createdAt\n      }\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query CheckMoonBoardClimbDuplicates($input: CheckMoonBoardClimbDuplicatesInput!) {\n    checkMoonBoardClimbDuplicates(input: $input) {\n      clientKey\n      exists\n      existingClimbUuid\n      existingClimbName\n    }\n  }\n',
): (typeof documents)['\n  query CheckMoonBoardClimbDuplicates($input: CheckMoonBoardClimbDuplicatesInput!) {\n    checkMoonBoardClimbDuplicates(input: $input) {\n      clientKey\n      exists\n      existingClimbUuid\n      existingClimbName\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query SimilarClimbs($input: SimilarClimbsInput!) {\n    similarClimbs(input: $input) {\n      uuid\n      name\n      setterUsername\n      angle\n      layoutId\n      frames\n      difficultyName\n      qualityAverage\n      ascensionistCount\n      compatibleSizeIds\n      similarity\n      sharedHoldCount\n      candidateHoldCount\n      targetHoldCount\n    }\n  }\n',
): (typeof documents)['\n  query SimilarClimbs($input: SimilarClimbsInput!) {\n    similarClimbs(input: $input) {\n      uuid\n      name\n      setterUsername\n      angle\n      layoutId\n      frames\n      difficultyName\n      qualityAverage\n      ascensionistCount\n      compatibleSizeIds\n      similarity\n      sharedHoldCount\n      candidateHoldCount\n      targetHoldCount\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SaveClimb($input: SaveClimbInput!) {\n    saveClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation SaveClimb($input: SaveClimbInput!) {\n    saveClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SaveMoonBoardClimb($input: SaveMoonBoardClimbInput!) {\n    saveMoonBoardClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation SaveMoonBoardClimb($input: SaveMoonBoardClimbInput!) {\n    saveMoonBoardClimb(input: $input) {\n      uuid\n      synced\n      createdAt\n      publishedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UpdateClimb($input: UpdateClimbInput!) {\n    updateClimb(input: $input) {\n      uuid\n      createdAt\n      publishedAt\n      isDraft\n    }\n  }\n',
): (typeof documents)['\n  mutation UpdateClimb($input: UpdateClimbInput!) {\n    updateClimb(input: $input) {\n      uuid\n      createdAt\n      publishedAt\n      isDraft\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation DeleteDraftClimb($uuid: ID!, $boardType: String!) {\n    deleteDraftClimb(uuid: $uuid, boardType: $boardType)\n  }\n',
): (typeof documents)['\n  mutation DeleteDraftClimb($uuid: ID!, $boardType: String!) {\n    deleteDraftClimb(uuid: $uuid, boardType: $boardType)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetNotifications($unreadOnly: Boolean, $limit: Int, $offset: Int) {\n    notifications(unreadOnly: $unreadOnly, limit: $limit, offset: $offset) {\n      notifications {\n        uuid\n        type\n        actorId\n        actorDisplayName\n        actorAvatarUrl\n        entityType\n        entityId\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetNotifications($unreadOnly: Boolean, $limit: Int, $offset: Int) {\n    notifications(unreadOnly: $unreadOnly, limit: $limit, offset: $offset) {\n      notifications {\n        uuid\n        type\n        actorId\n        actorDisplayName\n        actorAvatarUrl\n        entityType\n        entityId\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetGroupedNotifications($limit: Int, $offset: Int) {\n    groupedNotifications(limit: $limit, offset: $offset) {\n      groups {\n        uuid\n        type\n        entityType\n        entityId\n        actorCount\n        actors {\n          id\n          displayName\n          avatarUrl\n        }\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        setterUsername\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetGroupedNotifications($limit: Int, $offset: Int) {\n    groupedNotifications(limit: $limit, offset: $offset) {\n      groups {\n        uuid\n        type\n        entityType\n        entityId\n        actorCount\n        actors {\n          id\n          displayName\n          avatarUrl\n        }\n        commentBody\n        climbName\n        climbUuid\n        boardType\n        proposalUuid\n        setterUsername\n        isRead\n        createdAt\n      }\n      totalCount\n      unreadCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUnreadNotificationCount {\n    unreadNotificationCount\n  }\n',
): (typeof documents)['\n  query GetUnreadNotificationCount {\n    unreadNotificationCount\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation MarkNotificationRead($notificationUuid: ID!) {\n    markNotificationRead(notificationUuid: $notificationUuid)\n  }\n',
): (typeof documents)['\n  mutation MarkNotificationRead($notificationUuid: ID!) {\n    markNotificationRead(notificationUuid: $notificationUuid)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation MarkGroupNotificationsRead($type: NotificationType!, $entityType: SocialEntityType, $entityId: String) {\n    markGroupNotificationsRead(type: $type, entityType: $entityType, entityId: $entityId)\n  }\n',
): (typeof documents)['\n  mutation MarkGroupNotificationsRead($type: NotificationType!, $entityType: SocialEntityType, $entityId: String) {\n    markGroupNotificationsRead(type: $type, entityType: $entityType, entityId: $entityId)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation MarkAllNotificationsRead {\n    markAllNotificationsRead\n  }\n',
): (typeof documents)['\n  mutation MarkAllNotificationsRead {\n    markAllNotificationsRead\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  fragment PlaylistFields on Playlist {\n    id\n    uuid\n    boardType\n    layoutId\n    name\n    description\n    isPublic\n    color\n    icon\n    createdAt\n    updatedAt\n    lastAccessedAt\n    climbCount\n    userRole\n    followerCount\n    isFollowedByMe\n    isPinnedByMe\n  }\n',
): (typeof documents)['\n  fragment PlaylistFields on Playlist {\n    id\n    uuid\n    boardType\n    layoutId\n    name\n    description\n    isPublic\n    color\n    icon\n    createdAt\n    updatedAt\n    lastAccessedAt\n    climbCount\n    userRole\n    followerCount\n    isFollowedByMe\n    isPinnedByMe\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  query GetUserPlaylists($input: GetUserPlaylistsInput!) {\n    userPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n',
): (typeof documents)['\n  \n  query GetUserPlaylists($input: GetUserPlaylistsInput!) {\n    userPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  query GetAllUserPlaylists($input: GetAllUserPlaylistsInput!) {\n    allUserPlaylists(input: $input) {\n      playlists {\n        ...PlaylistFields\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  \n  query GetAllUserPlaylists($input: GetAllUserPlaylistsInput!) {\n    allUserPlaylists(input: $input) {\n      playlists {\n        ...PlaylistFields\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  query GetMyPinnedPlaylists($input: GetMyPinnedPlaylistsInput!) {\n    myPinnedPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n',
): (typeof documents)['\n  \n  query GetMyPinnedPlaylists($input: GetMyPinnedPlaylistsInput!) {\n    myPinnedPlaylists(input: $input) {\n      ...PlaylistFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation PinPlaylist($input: PinPlaylistInput!) {\n    pinPlaylist(input: $input)\n  }\n',
): (typeof documents)['\n  mutation PinPlaylist($input: PinPlaylistInput!) {\n    pinPlaylist(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UnpinPlaylist($input: PinPlaylistInput!) {\n    unpinPlaylist(input: $input)\n  }\n',
): (typeof documents)['\n  mutation UnpinPlaylist($input: PinPlaylistInput!) {\n    unpinPlaylist(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  query GetPlaylist($playlistId: ID!) {\n    playlist(playlistId: $playlistId) {\n      ...PlaylistFields\n    }\n  }\n',
): (typeof documents)['\n  \n  query GetPlaylist($playlistId: ID!) {\n    playlist(playlistId: $playlistId) {\n      ...PlaylistFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetPlaylistsForClimb($input: GetPlaylistsForClimbInput!) {\n    playlistsForClimb(input: $input)\n  }\n',
): (typeof documents)['\n  query GetPlaylistsForClimb($input: GetPlaylistsForClimbInput!) {\n    playlistsForClimb(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetPlaylistsForClimbs($input: GetPlaylistsForClimbsInput!) {\n    playlistsForClimbs(input: $input) {\n      climbUuid\n      playlistUuids\n    }\n  }\n',
): (typeof documents)['\n  query GetPlaylistsForClimbs($input: GetPlaylistsForClimbsInput!) {\n    playlistsForClimbs(input: $input) {\n      climbUuid\n      playlistUuids\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  mutation CreatePlaylist($input: CreatePlaylistInput!) {\n    createPlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n',
): (typeof documents)['\n  \n  mutation CreatePlaylist($input: CreatePlaylistInput!) {\n    createPlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  mutation UpdatePlaylist($input: UpdatePlaylistInput!) {\n    updatePlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n',
): (typeof documents)['\n  \n  mutation UpdatePlaylist($input: UpdatePlaylistInput!) {\n    updatePlaylist(input: $input) {\n      ...PlaylistFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation DeletePlaylist($playlistId: ID!) {\n    deletePlaylist(playlistId: $playlistId)\n  }\n',
): (typeof documents)['\n  mutation DeletePlaylist($playlistId: ID!) {\n    deletePlaylist(playlistId: $playlistId)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) {\n    addClimbToPlaylist(input: $input) {\n      id\n      playlistId\n      climbUuid\n      angle\n      position\n      addedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) {\n    addClimbToPlaylist(input: $input) {\n      id\n      playlistId\n      climbUuid\n      angle\n      position\n      addedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) {\n    removeClimbFromPlaylist(input: $input)\n  }\n',
): (typeof documents)['\n  mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) {\n    removeClimbFromPlaylist(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation ReorderPlaylistClimb($input: ReorderPlaylistClimbInput!) {\n    reorderPlaylistClimb(input: $input)\n  }\n',
): (typeof documents)['\n  mutation ReorderPlaylistClimb($input: ReorderPlaylistClimbInput!) {\n    reorderPlaylistClimb(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetPlaylistClimbs($input: GetPlaylistClimbsInput!) {\n    playlistClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetPlaylistClimbs($input: GetPlaylistClimbsInput!) {\n    playlistClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query DiscoverPlaylists($input: DiscoverPlaylistsInput!) {\n    discoverPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        createdAt\n        updatedAt\n        climbCount\n        creatorId\n        creatorName\n        isGeneratedRecommendation\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query DiscoverPlaylists($input: DiscoverPlaylistsInput!) {\n    discoverPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        createdAt\n        updatedAt\n        climbCount\n        creatorId\n        creatorName\n        isGeneratedRecommendation\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetPlaylistCreators($input: GetPlaylistCreatorsInput!) {\n    playlistCreators(input: $input) {\n      userId\n      displayName\n      playlistCount\n    }\n  }\n',
): (typeof documents)['\n  query GetPlaylistCreators($input: GetPlaylistCreatorsInput!) {\n    playlistCreators(input: $input) {\n      userId\n      displayName\n      playlistCount\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UpdatePlaylistLastAccessed($playlistId: ID!) {\n    updatePlaylistLastAccessed(playlistId: $playlistId)\n  }\n',
): (typeof documents)['\n  mutation UpdatePlaylistLastAccessed($playlistId: ID!) {\n    updatePlaylistLastAccessed(playlistId: $playlistId)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query SearchPlaylists($input: SearchPlaylistsInput!) {\n    searchPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        climbCount\n        creatorId\n        creatorName\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query SearchPlaylists($input: SearchPlaylistsInput!) {\n    searchPlaylists(input: $input) {\n      playlists {\n        id\n        uuid\n        boardType\n        layoutId\n        name\n        description\n        color\n        icon\n        climbCount\n        creatorId\n        creatorName\n        createdAt\n        updatedAt\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation FollowPlaylist($input: FollowPlaylistInput!) {\n    followPlaylist(input: $input)\n  }\n',
): (typeof documents)['\n  mutation FollowPlaylist($input: FollowPlaylistInput!) {\n    followPlaylist(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UnfollowPlaylist($input: FollowPlaylistInput!) {\n    unfollowPlaylist(input: $input)\n  }\n',
): (typeof documents)['\n  mutation UnfollowPlaylist($input: FollowPlaylistInput!) {\n    unfollowPlaylist(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetSmartPlaylist($input: GetSmartPlaylistInput!) {\n    smartPlaylist(input: $input) {\n      meta {\n        type\n        userId\n        userName\n        userAvatar\n        climbCount\n      }\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetSmartPlaylist($input: GetSmartPlaylistInput!) {\n    smartPlaylist(input: $input) {\n      meta {\n        type\n        userId\n        userName\n        userAvatar\n        climbCount\n      }\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetMySmartPlaylistCounts {\n    mySmartPlaylistCounts {\n      type\n      count\n    }\n  }\n',
): (typeof documents)['\n  query GetMySmartPlaylistCounts {\n    mySmartPlaylistCounts {\n      type\n      count\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetClimbProposals($input: GetClimbProposalsInput!) {\n    climbProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetClimbProposals($input: GetClimbProposalsInput!) {\n    climbProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetClimbCommunityStatus($climbUuid: String!, $boardType: String!, $angle: Int!) {\n    climbCommunityStatus(climbUuid: $climbUuid, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      outlierAnalysis {\n        isOutlier\n        currentGrade\n        neighborAverage\n        neighborCount\n        gradeDifference\n      }\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  query GetClimbCommunityStatus($climbUuid: String!, $boardType: String!, $angle: Int!) {\n    climbCommunityStatus(climbUuid: $climbUuid, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      outlierAnalysis {\n        isOutlier\n        currentGrade\n        neighborAverage\n        neighborCount\n        gradeDifference\n      }\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetBulkClimbCommunityStatus($climbUuids: [String!]!, $boardType: String!, $angle: Int!) {\n    bulkClimbCommunityStatus(climbUuids: $climbUuids, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  query GetBulkClimbCommunityStatus($climbUuids: [String!]!, $boardType: String!, $angle: Int!) {\n    bulkClimbCommunityStatus(climbUuids: $climbUuids, boardType: $boardType, angle: $angle) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      freezeReason\n      openProposalCount\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query BrowseProposals($input: BrowseProposalsInput!) {\n    browseProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query BrowseProposals($input: BrowseProposalsInput!) {\n    browseProposals(input: $input) {\n      proposals {\n        uuid\n        climbUuid\n        boardType\n        angle\n        proposerId\n        proposerDisplayName\n        proposerAvatarUrl\n        type\n        proposedValue\n        currentValue\n        status\n        reason\n        resolvedAt\n        resolvedBy\n        createdAt\n        weightedUpvotes\n        weightedDownvotes\n        requiredUpvotes\n        userVote\n        climbName\n        frames\n        layoutId\n        climbSetterUsername\n        climbDifficulty\n        climbQualityAverage\n        climbAscensionistCount\n        climbDifficultyError\n        climbBenchmarkDifficulty\n        climbIsNoMatch\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetClimbClassicStatus($climbUuid: String!, $boardType: String!) {\n    climbClassicStatus(climbUuid: $climbUuid, boardType: $boardType) {\n      climbUuid\n      boardType\n      isClassic\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  query GetClimbClassicStatus($climbUuid: String!, $boardType: String!) {\n    climbClassicStatus(climbUuid: $climbUuid, boardType: $boardType) {\n      climbUuid\n      boardType\n      isClassic\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation CreateProposal($input: CreateProposalInput!) {\n    createProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n',
): (typeof documents)['\n  mutation CreateProposal($input: CreateProposalInput!) {\n    createProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation VoteOnProposal($input: VoteOnProposalInput!) {\n    voteOnProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      resolvedAt\n      resolvedBy\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n',
): (typeof documents)['\n  mutation VoteOnProposal($input: VoteOnProposalInput!) {\n    voteOnProposal(input: $input) {\n      uuid\n      climbUuid\n      boardType\n      angle\n      proposerId\n      proposerDisplayName\n      proposerAvatarUrl\n      type\n      proposedValue\n      currentValue\n      status\n      reason\n      resolvedAt\n      resolvedBy\n      createdAt\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation ResolveProposal($input: ResolveProposalInput!) {\n    resolveProposal(input: $input) {\n      uuid\n      status\n      resolvedAt\n      resolvedBy\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n',
): (typeof documents)['\n  mutation ResolveProposal($input: ResolveProposalInput!) {\n    resolveProposal(input: $input) {\n      uuid\n      status\n      resolvedAt\n      resolvedBy\n      weightedUpvotes\n      weightedDownvotes\n      requiredUpvotes\n      userVote\n      climbName\n      frames\n      layoutId\n      climbSetterUsername\n      climbDifficulty\n      climbQualityAverage\n      climbAscensionistCount\n      climbDifficultyError\n      climbBenchmarkDifficulty\n      climbIsNoMatch\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation DeleteProposal($input: DeleteProposalInput!) {\n    deleteProposal(input: $input)\n  }\n',
): (typeof documents)['\n  mutation DeleteProposal($input: DeleteProposalInput!) {\n    deleteProposal(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SetterOverrideCommunityStatus($input: SetterOverrideInput!) {\n    setterOverrideCommunityStatus(input: $input) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation SetterOverrideCommunityStatus($input: SetterOverrideInput!) {\n    setterOverrideCommunityStatus(input: $input) {\n      climbUuid\n      boardType\n      angle\n      communityGrade\n      isBenchmark\n      isClassic\n      isFrozen\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation FreezeClimb($input: FreezeClimbInput!) {\n    freezeClimb(input: $input)\n  }\n',
): (typeof documents)['\n  mutation FreezeClimb($input: FreezeClimbInput!) {\n    freezeClimb(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetCommunityRoles($boardType: String) {\n    communityRoles(boardType: $boardType) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n',
): (typeof documents)['\n  query GetCommunityRoles($boardType: String) {\n    communityRoles(boardType: $boardType) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetMyRoles {\n    myRoles {\n      id\n      userId\n      role\n      boardType\n      createdAt\n    }\n  }\n',
): (typeof documents)['\n  query GetMyRoles {\n    myRoles {\n      id\n      userId\n      role\n      boardType\n      createdAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation GrantRole($input: GrantRoleInput!) {\n    grantRole(input: $input) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n',
): (typeof documents)['\n  mutation GrantRole($input: GrantRoleInput!) {\n    grantRole(input: $input) {\n      id\n      userId\n      userDisplayName\n      userAvatarUrl\n      role\n      boardType\n      grantedBy\n      grantedByDisplayName\n      createdAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation RevokeRole($input: RevokeRoleInput!) {\n    revokeRole(input: $input)\n  }\n',
): (typeof documents)['\n  mutation RevokeRole($input: RevokeRoleInput!) {\n    revokeRole(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetCommunitySettings($scope: String!, $scopeKey: String!) {\n    communitySettings(scope: $scope, scopeKey: $scopeKey) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  query GetCommunitySettings($scope: String!, $scopeKey: String!) {\n    communitySettings(scope: $scope, scopeKey: $scopeKey) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SetCommunitySettings($input: SetCommunitySettingInput!) {\n    setCommunitySettings(input: $input) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation SetCommunitySettings($input: SetCommunitySettingInput!) {\n    setCommunitySettings(input: $input) {\n      id\n      scope\n      scopeKey\n      key\n      value\n      setBy\n      createdAt\n      updatedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  fragment SessionSummaryFields on SessionSummary {\n    sessionId\n    totalSends\n    totalAttempts\n    gradeDistribution {\n      grade\n      count\n    }\n    hardestClimb {\n      climbUuid\n      climbName\n      grade\n    }\n    participants {\n      userId\n      displayName\n      avatarUrl\n      sends\n      attempts\n    }\n    startedAt\n    endedAt\n    durationMinutes\n    goal\n  }\n',
): (typeof documents)['\n  fragment SessionSummaryFields on SessionSummary {\n    sessionId\n    totalSends\n    totalAttempts\n    gradeDistribution {\n      grade\n      count\n    }\n    hardestClimb {\n      climbUuid\n      climbName\n      grade\n    }\n    participants {\n      userId\n      displayName\n      avatarUrl\n      sends\n      attempts\n    }\n    startedAt\n    endedAt\n    durationMinutes\n    goal\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  mutation EndSession($sessionId: ID!, $timezone: String) {\n    endSession(sessionId: $sessionId, timezone: $timezone) {\n      ...SessionSummaryFields\n    }\n  }\n',
): (typeof documents)['\n  \n  mutation EndSession($sessionId: ID!, $timezone: String) {\n    endSession(sessionId: $sessionId, timezone: $timezone) {\n      ...SessionSummaryFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  \n  query GetSessionSummary($sessionId: ID!) {\n    sessionSummary(sessionId: $sessionId) {\n      ...SessionSummaryFields\n    }\n  }\n',
): (typeof documents)['\n  \n  query GetSessionSummary($sessionId: ID!) {\n    sessionSummary(sessionId: $sessionId) {\n      ...SessionSummaryFields\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation FollowUser($input: FollowInput!) {\n    followUser(input: $input)\n  }\n',
): (typeof documents)['\n  mutation FollowUser($input: FollowInput!) {\n    followUser(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UnfollowUser($input: FollowInput!) {\n    unfollowUser(input: $input)\n  }\n',
): (typeof documents)['\n  mutation UnfollowUser($input: FollowInput!) {\n    unfollowUser(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetPublicProfile($userId: ID!) {\n    publicProfile(userId: $userId) {\n      id\n      displayName\n      avatarUrl\n      followerCount\n      followingCount\n      isFollowedByMe\n    }\n  }\n',
): (typeof documents)['\n  query GetPublicProfile($userId: ID!) {\n    publicProfile(userId: $userId) {\n      id\n      displayName\n      avatarUrl\n      followerCount\n      followingCount\n      isFollowedByMe\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetFollowers($input: FollowListInput!) {\n    followers(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetFollowers($input: FollowListInput!) {\n    followers(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetFollowing($input: FollowListInput!) {\n    following(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetFollowing($input: FollowListInput!) {\n    following(input: $input) {\n      users {\n        id\n        displayName\n        avatarUrl\n        followerCount\n        followingCount\n        isFollowedByMe\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query IsFollowing($userId: ID!) {\n    isFollowing(userId: $userId)\n  }\n',
): (typeof documents)['\n  query IsFollowing($userId: ID!) {\n    isFollowing(userId: $userId)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query SearchUsers($input: SearchUsersInput!) {\n    searchUsers(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query SearchUsers($input: SearchUsersInput!) {\n    searchUsers(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetFollowingAscentsFeed($input: FollowingAscentsFeedInput) {\n    followingAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetFollowingAscentsFeed($input: FollowingAscentsFeedInput) {\n    followingAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetGlobalAscentsFeed($input: FollowingAscentsFeedInput) {\n    globalAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetGlobalAscentsFeed($input: FollowingAscentsFeedInput) {\n    globalAscentsFeed(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetFollowingClimbAscents($input: FollowingClimbAscentsInput!) {\n    followingClimbAscents(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        comment\n        climbedAt\n        upvotes\n        downvotes\n        commentCount\n      }\n    }\n  }\n',
): (typeof documents)['\n  query GetFollowingClimbAscents($input: FollowingClimbAscentsInput!) {\n    followingClimbAscents(input: $input) {\n      items {\n        uuid\n        userId\n        userDisplayName\n        userAvatarUrl\n        climbUuid\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        comment\n        climbedAt\n        upvotes\n        downvotes\n        commentCount\n      }\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation FollowSetter($input: FollowSetterInput!) {\n    followSetter(input: $input)\n  }\n',
): (typeof documents)['\n  mutation FollowSetter($input: FollowSetterInput!) {\n    followSetter(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UnfollowSetter($input: FollowSetterInput!) {\n    unfollowSetter(input: $input)\n  }\n',
): (typeof documents)['\n  mutation UnfollowSetter($input: FollowSetterInput!) {\n    unfollowSetter(input: $input)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetSetterProfile($input: SetterProfileInput!) {\n    setterProfile(input: $input) {\n      username\n      climbCount\n      boardTypes\n      followerCount\n      isFollowedByMe\n      linkedUserId\n      linkedUserDisplayName\n      linkedUserAvatarUrl\n    }\n  }\n',
): (typeof documents)['\n  query GetSetterProfile($input: SetterProfileInput!) {\n    setterProfile(input: $input) {\n      username\n      climbCount\n      boardTypes\n      followerCount\n      isFollowedByMe\n      linkedUserId\n      linkedUserDisplayName\n      linkedUserAvatarUrl\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetSetterClimbsFull($input: SetterClimbsFullInput!) {\n    setterClimbsFull(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetSetterClimbsFull($input: SetterClimbsFullInput!) {\n    setterClimbsFull(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserClimbs($input: UserClimbsInput!) {\n    userClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetUserClimbs($input: UserClimbsInput!) {\n    userClimbs(input: $input) {\n      climbs {\n        uuid\n        layoutId\n        boardType\n        setter_username\n        name\n        description\n        frames\n        framesCount\n        framesPace\n        angle\n        ascensionist_count\n        difficulty\n        quality_average\n        stars\n        difficulty_error\n        benchmark_difficulty\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query SearchUsersAndSetters($input: SearchUsersInput!) {\n    searchUsersAndSetters(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        setter {\n          username\n          climbCount\n          boardTypes\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query SearchUsersAndSetters($input: SearchUsersInput!) {\n    searchUsersAndSetters(input: $input) {\n      results {\n        user {\n          id\n          displayName\n          avatarUrl\n          followerCount\n          followingCount\n          isFollowedByMe\n        }\n        setter {\n          username\n          climbCount\n          boardTypes\n          isFollowedByMe\n        }\n        recentAscentCount\n        matchReason\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetTicks($input: GetTicksInput!) {\n    ticks(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      upvotes\n      downvotes\n      commentCount\n    }\n  }\n',
): (typeof documents)['\n  query GetTicks($input: GetTicksInput!) {\n    ticks(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      upvotes\n      downvotes\n      commentCount\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserTicks($userId: ID!, $boardType: String!) {\n    userTicks(userId: $userId, boardType: $boardType) {\n      climbUuid\n      angle\n      status\n      attemptCount\n      difficulty\n      effectiveDifficulty\n      climbedAt\n      layoutId\n    }\n  }\n',
): (typeof documents)['\n  query GetUserTicks($userId: ID!, $boardType: String!) {\n    userTicks(userId: $userId, boardType: $boardType) {\n      climbUuid\n      angle\n      status\n      attemptCount\n      difficulty\n      effectiveDifficulty\n      climbedAt\n      layoutId\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation SaveTick($input: SaveTickInput!) {\n    saveTick(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      comment\n      climbedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation SaveTick($input: SaveTickInput!) {\n    saveTick(input: $input) {\n      uuid\n      climbUuid\n      angle\n      isMirror\n      status\n      attemptCount\n      quality\n      difficulty\n      comment\n      climbedAt\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation DeleteTick($uuid: ID!) {\n    deleteTick(uuid: $uuid)\n  }\n',
): (typeof documents)['\n  mutation DeleteTick($uuid: ID!) {\n    deleteTick(uuid: $uuid)\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userAscentsFeed(userId: $userId, input: $input) {\n      items {\n        uuid\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        boardId\n        boardDisplayName\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        consensusDifficulty\n        consensusDifficultyName\n        qualityAverage\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetUserAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userAscentsFeed(userId: $userId, input: $input) {\n      items {\n        uuid\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        boardId\n        boardDisplayName\n        layoutId\n        angle\n        isMirror\n        status\n        attemptCount\n        quality\n        difficulty\n        difficultyName\n        consensusDifficulty\n        consensusDifficultyName\n        qualityAverage\n        isBenchmark\n        isNoMatch\n        comment\n        climbedAt\n        frames\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserGroupedAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userGroupedAscentsFeed(userId: $userId, input: $input) {\n      groups {\n        key\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        frames\n        difficultyName\n        isBenchmark\n        isNoMatch\n        date\n        flashCount\n        sendCount\n        attemptCount\n        bestQuality\n        latestComment\n        items {\n          uuid\n          climbUuid\n          climbName\n          setterUsername\n          boardType\n          layoutId\n          angle\n          isMirror\n          status\n          attemptCount\n          quality\n          difficulty\n          difficultyName\n          isBenchmark\n          isNoMatch\n          comment\n          climbedAt\n          frames\n        }\n      }\n      totalCount\n      hasMore\n    }\n  }\n',
): (typeof documents)['\n  query GetUserGroupedAscentsFeed($userId: ID!, $input: AscentFeedInput) {\n    userGroupedAscentsFeed(userId: $userId, input: $input) {\n      groups {\n        key\n        climbUuid\n        climbName\n        setterUsername\n        boardType\n        layoutId\n        angle\n        isMirror\n        frames\n        difficultyName\n        isBenchmark\n        isNoMatch\n        date\n        flashCount\n        sendCount\n        attemptCount\n        bestQuality\n        latestComment\n        items {\n          uuid\n          climbUuid\n          climbName\n          setterUsername\n          boardType\n          layoutId\n          angle\n          isMirror\n          status\n          attemptCount\n          quality\n          difficulty\n          difficultyName\n          isBenchmark\n          isNoMatch\n          comment\n          climbedAt\n          frames\n        }\n      }\n      totalCount\n      hasMore\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserProfileStats($userId: ID!) {\n    userProfileStats(userId: $userId) {\n      totalDistinctClimbs\n      layoutStats {\n        layoutKey\n        boardType\n        layoutId\n        distinctClimbCount\n        gradeCounts {\n          grade\n          count\n        }\n      }\n    }\n  }\n',
): (typeof documents)['\n  query GetUserProfileStats($userId: ID!) {\n    userProfileStats(userId: $userId) {\n      totalDistinctClimbs\n      layoutStats {\n        layoutKey\n        boardType\n        layoutId\n        distinctClimbCount\n        gradeCounts {\n          grade\n          count\n        }\n      }\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  query GetUserClimbPercentile($userId: ID!) {\n    userClimbPercentile(userId: $userId) {\n      totalDistinctClimbs\n      percentile\n      totalActiveUsers\n    }\n  }\n',
): (typeof documents)['\n  query GetUserClimbPercentile($userId: ID!) {\n    userClimbPercentile(userId: $userId) {\n      totalDistinctClimbs\n      percentile\n      totalActiveUsers\n    }\n  }\n'];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(
  source: '\n  mutation UpdateTick($uuid: ID!, $input: UpdateTickInput!) {\n    updateTick(uuid: $uuid, input: $input) {\n      uuid\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      updatedAt\n    }\n  }\n',
): (typeof documents)['\n  mutation UpdateTick($uuid: ID!, $input: UpdateTickInput!) {\n    updateTick(uuid: $uuid, input: $input) {\n      uuid\n      status\n      attemptCount\n      quality\n      difficulty\n      isBenchmark\n      comment\n      climbedAt\n      updatedAt\n    }\n  }\n'];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> =
  TDocumentNode extends DocumentNode<infer TType, any> ? TType : never;
