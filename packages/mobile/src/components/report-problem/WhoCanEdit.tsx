// The board and gym edit routes' "you can't edit this" state (design §3e). It
// used to be a lock and "You don't have permission"; now it says who can
// change the thing and what the climber can do instead: report a problem,
// claim the gym, or go back. Hosted inside the route, so the report and claim
// sheets present above it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { TextAction } from '../TextAction';
import { ClaimGymSheet } from '../gym-directory/ClaimGymSheet';
import { useGym } from '../../lib/graphql/hooks';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { spacing } from '../../theme/tokens';
import { useReportProblem, type ReportProblemTarget } from './use-report-problem';
import { boardWhoCanEditBody, gymWhoCanEditBody } from './who-can-edit-copy';

/** The claim sheet, mounted for one gym on demand and presented once mounted. */
function useClaimSheet() {
  const [claimGym, setClaimGym] = useState<Gym | null>(null);
  const sheetRef = useRef<ManagedSheetHandle>(null);
  useEffect(() => {
    if (claimGym) sheetRef.current?.present();
  }, [claimGym]);
  const onClosed = useCallback(() => setClaimGym(null), []);
  const sheet = claimGym ? (
    <ClaimGymSheet key={claimGym.uuid} sheetRef={sheetRef} gym={claimGym} onClosed={onClosed} />
  ) : null;
  return { openClaim: setClaimGym, sheet };
}

export function WhoCanEditBoard({ board, onBack }: { board: UserBoard; onBack: () => void }) {
  const { t } = useTranslation('boards');
  const viewerUserId = useViewerUserId();
  const { data: gym } = useGym(board.gymUuid ?? null);
  const target = useMemo<ReportProblemTarget>(() => ({ kind: 'board', board }), [board]);
  const report = useReportProblem({ target });
  const claim = useClaimSheet();
  const claimable = gym && gym.canClaim ? gym : null;

  return (
    <View style={styles.flex}>
      <EmptyState
        size="screen"
        icon="lock"
        title={t('whoCanEdit.boardTitle')}
        body={boardWhoCanEditBody(board, gym ?? null, viewerUserId, t)}
        testID="who-can-edit-board"
        actions={
          <View style={styles.actions}>
            {report ? <Button title={t('report.action')} variant="filled" onPress={report.open} /> : null}
            {claimable ? (
              <TextAction
                label={t('whoCanEdit.claimGym', { gym: claimable.name })}
                onPress={() => claim.openClaim(claimable)}
              />
            ) : null}
            <Button title={t('whoCanEdit.goBack')} variant={report ? 'text' : 'outlined'} onPress={onBack} />
          </View>
        }
      />
      {report?.sheet}
      {claim.sheet}
    </View>
  );
}

export function WhoCanEditGym({ gym, onBack }: { gym: Gym; onBack: () => void }) {
  const { t } = useTranslation('boards');
  const target = useMemo<ReportProblemTarget>(() => ({ kind: 'gym', gym }), [gym]);
  const report = useReportProblem({ target });
  const claim = useClaimSheet();

  return (
    <View style={styles.flex}>
      <EmptyState
        size="screen"
        icon="lock"
        title={t('whoCanEdit.gymTitle')}
        body={gymWhoCanEditBody(gym, t)}
        testID="who-can-edit-gym"
        actions={
          <View style={styles.actions}>
            {gym.canClaim ? (
              <Button title={t('whoCanEdit.claimThisGym')} variant="filled" onPress={() => claim.openClaim(gym)} />
            ) : null}
            {report ? (
              <Button title={t('report.action')} variant={gym.canClaim ? 'outlined' : 'filled'} onPress={report.open} />
            ) : null}
            <Button
              title={t('whoCanEdit.goBack')}
              variant={gym.canClaim || report ? 'text' : 'outlined'}
              onPress={onBack}
            />
          </View>
        }
      />
      {report?.sheet}
      {claim.sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  actions: { gap: spacing[2], alignItems: 'center' },
});
