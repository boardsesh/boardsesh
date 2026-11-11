/** Private planning evidence only. A shared address never authorizes an account merge. */
import { buildAccountEmailEvidence, type CollectedEvidence } from './evidence';
import type { MergeConflictFacts } from './merge-snapshot';

export const MERGE_PREVIEW_LIMITATIONS = Object.freeze([
  'Matching email, display name, verification stamp or historical provider link does not prove control of every account.',
  'Foreign-key discovery misses unreferenced user IDs, including logbook_changes.user_id and sync_deletions.user_id.',
  'Check constraints, triggers, RLS, permissions and application rules are not simulated by unique-index counts.',
  'Tick candidates are possible duplicates, not proof of duplicate ascents; no record is selected for deletion.',
  'Offline queues, sync cursors, delayed provider jobs and derived statistics require a separate reconciliation plan.',
  'A read-only snapshot does not fence writers or prove that a future merge can commit safely.',
]);

export function buildAccountEmailMergePreview(evidence: CollectedEvidence, conflicts: MergeConflictFacts) {
  const { worksheet } = buildAccountEmailEvidence(evidence);
  if (Object.values(worksheet.summary.checks).some((passed) => !passed))
    throw new Error('Merge preview requires reconciled evidence.');
  const groups = worksheet.groups.map((group) => {
    const uniqueCollisions = conflicts.uniqueIndexes.flatMap((index) =>
      index.collisions
        .filter((collision) => collision.address === group.address)
        .map(({ address: _address, ...collision }) => ({
          schema: index.schema,
          table: index.table,
          index: index.index,
          ...collision,
        })),
    );
    const tickCandidates = conflicts.tickCandidates.filter((candidate) => candidate.address === group.address);
    const boardMappings = conflicts.boardMappings.filter((mapping) => mapping.address === group.address);
    return {
      group: group.group,
      address: group.address,
      status: 'blocked_pending_ownership_and_rehearsal' as const,
      survivingUserId: null,
      members: group.members,
      review: {
        ownership:
          'Prove current control of each account through its own authenticated sign-in; record consent privately.',
        passwordChoiceRequired: group.members.filter((member) => member.hasPassword).length > 1,
        profileAndPrivacyChoiceRequired: true,
        sessionAndOfflineReconciliationRequired: true,
        uniqueCollisions,
        tickCandidates,
        boardMappings,
      },
    };
  });
  return {
    formatVersion: 1,
    document: 'boardsesh-account-email-merge-preview' as const,
    privacy: 'Private account evidence. Keep outside repositories, issues, chat and CI logs.',
    snapshot: evidence.snapshot,
    authorization: 'Read-only planning only. No ownership approval, survivor selection, merge or deletion.',
    summary: {
      groups: groups.length,
      members: groups.reduce((total, group) => total + group.members.length, 0),
      readyToMerge: 0,
      groupsWithDataOnMultipleAccounts: groups.filter(
        (group) => group.members.filter((member) => member.hasOwnData).length > 1,
      ).length,
      groupsWithMultiplePasswords: groups.filter((group) => group.review.passwordChoiceRequired).length,
      groupsWithUniqueCollisions: groups.filter((group) => group.review.uniqueCollisions.length > 0).length,
      groupsWithTickCandidates: groups.filter((group) => group.review.tickCandidates.length > 0).length,
      groupsWithDifferentBoardIdentities: groups.filter((group) =>
        group.review.boardMappings.some((mapping) => mapping.distinctUpstreamIdentities > 1),
      ).length,
      countedUniqueIndexes: conflicts.uniqueIndexes.filter((index) => index.analysis === 'counted').length,
      unsupportedUniqueIndexes: conflicts.uniqueIndexes.filter((index) => index.analysis === 'unsupported').length,
    },
    coverage: {
      status: 'incomplete_for_merge' as const,
      limitations: [...MERGE_PREVIEW_LIMITATIONS, ...conflicts.limitations],
      uniqueIndexes: conflicts.uniqueIndexes,
    },
    groups,
  };
}
