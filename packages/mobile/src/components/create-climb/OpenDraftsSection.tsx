import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { CollapsibleSection } from '../CollapsibleSection';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useSearchClimbs, useDeleteDraftClimb } from '../../lib/graphql/hooks';
import { useHttpActionScope, type HttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { useHttpQueryScope } from '../../lib/graphql/use-http-query-scope';
import { useHttpQuery } from '../../lib/graphql/use-http-query';
import { useAuthToken } from '../../lib/graphql/use-auth-token';
import { useGradeSourceSearchInput } from '../../lib/graphql/hooks/search-grade-source';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../lib/graphql/operations';
import { SEARCH_CLIMBS_QUERY_KEY } from '../../lib/graphql/query-keys';
import { spacing } from '../../theme/tokens';
import { DraftRow } from './DraftRow';

type BoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type OpenDraftsSectionProps = {
  board: BoardConfig;
  onLoadDraft: (climb: Climb) => void;
};

/**
 * Below-the-fold "Open drafts" table: the climber's saved drafts for the active
 * board, in a collapsible section. Tapping a row loads it into the editor; the
 * trash icon deletes it (with confirm). Reuses the drafts query + delete
 * mutation; the delete already invalidates the search cache, so the list
 * refreshes itself.
 */
export function OpenDraftsSection(props: OpenDraftsSectionProps) {
  const scope = useHttpQueryScope();
  const actionScope = useHttpActionScope();
  return <OwnedOpenDraftsSection key={actionScope.key} {...props} actionScope={actionScope} scoped={scope.scoped} />;
}

function OwnedOpenDraftsSection({
  board,
  onLoadDraft,
  actionScope,
  scoped,
}: OpenDraftsSectionProps & { actionScope: HttpActionScope; scoped: boolean }) {
  const { capture: captureAction } = actionScope;
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const deleteDraft = useDeleteDraftClimb();

  // Defer the drafts query until the section is actually expanded. The drawer
  // opens at peek with this below the fold, so most opens never need it — the
  // old DraftsSheet likewise only fetched while visible.
  const [sectionOpen, setSectionOpen] = useState(false);

  const searchInput = useMemo<ClimbSearchInput>(
    () => ({
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      page: 0,
      pageSize: 50,
      onlyDrafts: true,
      draftScope: 'OWN',
      sortBy: 'creation',
      sortOrder: 'desc',
    }),
    [board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle],
  );

  const handleDelete = useCallback(
    async (climb: Climb) => {
      let action: ReturnType<typeof captureAction>;
      try {
        action = captureAction();
      } catch {
        return;
      }
      try {
        const confirmed = await confirm({
          title: t('draftsDrawer.delete.title'),
          message: t('draftsDrawer.delete.description'),
          confirmLabel: t('draftsDrawer.delete.confirm'),
          cancelLabel: t('createClimbForm.dismiss'),
          destructive: true,
        });
        action.assertView();
        if (!confirmed) return;
        const receipt = await deleteDraft.mutateWithReceipt(
          { uuid: climb.uuid, boardType: board.boardName },
          { signal: action.signal },
        );
        action.assertView();
        receipt.assertCurrent();
        showToast(t('draftsDrawer.delete.success'), 'success');
      } catch (error) {
        if (action.isCurrent() && !(error instanceof BrowserBackendConsumerError))
          showToast(t('draftsDrawer.delete.error'), 'error');
      } finally {
        action.finish();
      }
    },
    [captureAction, confirm, board.boardName, deleteDraft, showToast, t],
  );

  const handleLoadDraft = useCallback(
    (climb: Climb) => {
      let action: ReturnType<typeof captureAction>;
      try {
        action = captureAction();
      } catch {
        return;
      }
      try {
        action.assertView();
        onLoadDraft(climb);
      } finally {
        action.finish();
      }
    },
    [captureAction, onLoadDraft],
  );

  const renderDrafts = ({ data, isLoading, isError }: DraftsQueryState) => {
    const drafts = data?.climbs ?? [];

    const summary = drafts.length > 0 ? t('draftsDrawer.count', { count: drafts.length }) : null;

    return (
      <CollapsibleSection
        title={t('mobile.create.drafts.sectionTitle')}
        summary={summary}
        onExpandedChange={setSectionOpen}
      >
        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" />
          </View>
        ) : isError ? (
          <View style={styles.centered}>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('draftsDrawer.loadError')}
            </Text>
          </View>
        ) : drafts.length === 0 ? (
          <View style={styles.centered}>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyText}>
              {t('draftsDrawer.empty.title')}
            </Text>
          </View>
        ) : (
          <View>
            {drafts.map((climb) => (
              <DraftRow key={climb.uuid} climb={climb} onPress={handleLoadDraft} onDelete={handleDelete} />
            ))}
          </View>
        )}
      </CollapsibleSection>
    );
  };
  return scoped ? (
    <SelectedDraftsQuery input={searchInput} enabled={sectionOpen} render={renderDrafts} />
  ) : (
    <NativeDraftsQuery input={searchInput} enabled={sectionOpen} render={renderDrafts} />
  );
}

type DraftsQueryState = Pick<ReturnType<typeof useSearchClimbs>, 'data' | 'isLoading' | 'isError'>;
type DraftsQueryProps = { input: ClimbSearchInput; enabled: boolean; render: (query: DraftsQueryState) => ReactNode };

function NativeDraftsQuery({ input, enabled, render }: DraftsQueryProps) {
  return render(useSearchClimbs(input, enabled));
}

function SelectedDraftsQuery({ input: requestedInput, enabled, render }: DraftsQueryProps) {
  const input = useGradeSourceSearchInput(requestedInput);
  const scope = useHttpQueryScope();
  const { data: authToken } = useAuthToken();
  const canRead = !!authToken && scope.isReady();
  const query = useHttpQuery({
    queryKey: [...SEARCH_CLIMBS_QUERY_KEY, input],
    queryFn: (_context, operation) => operation.request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input }),
    select: (response) => response.searchClimbs,
    enabled: enabled && canRead,
    networkMode: 'always',
  });
  return render({ ...query, data: canRead ? query.data : undefined, isLoading: !canRead || query.isLoading });
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[6],
    gap: spacing[2],
  },
  emptyText: {
    textAlign: 'center',
  },
});
