// "Where's this board?" (#8151): the one question before a board is set up,
// for the entries that haven't asked it yet: the picker's empty state, Manage
// boards' Create board, and a bare open of the builder. A home board goes to
// the builder; a gym board goes to finding the wall that's probably already
// there. Only reachable with the `create-board-gym-first` flag on.

import { useCallback, useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ChoiceCard } from '../../src/components/board-discovery/FirstBoardChoice';
import { addBoardRoute } from '../../src/components/board-discovery/add-board-route';
import { trackBoardKindChosen, type BoardKind } from '../../src/lib/boards/board-picker-add-analytics';
import { boardFlowTicket, claimBoardFlowAbandonment } from '../../src/lib/boards/board-create-flow';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { track } from '../../src/lib/analytics';
import { spacing } from '../../src/theme/tokens';

export default function BoardWhere() {
  const params = useLocalSearchParams<{ returnTo?: string; source?: string }>();
  const router = useRouter();
  const { t } = useTranslation('boards');
  const bottomChrome = useBottomChromeMetrics();
  const { returnTo, source } = params;

  // `Board Builder Abandoned` at step `choice`: the climber left without
  // answering. A deeper screen that reported first, or a board secured
  // anywhere down the flow, keeps this one quiet (board-create-flow.ts).
  useEffect(() => {
    const openedAtMs = Date.now();
    const ticket = boardFlowTicket();
    return () => {
      if (!claimBoardFlowAbandonment(ticket)) return;
      track(SHARED_EVENTS.BoardBuilderAbandoned, {
        kind: null,
        step: 'choice',
        openedFrom: source ?? null,
        secondsOpen: Math.round((Date.now() - openedAtMs) / 1000),
      });
    };
    // Once per screen: the route's params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = useCallback(
    (kind: BoardKind) => {
      trackBoardKindChosen({ kind, surface: 'where', preAnswered: false });
      router.push(addBoardRoute('board', { returnTo, source, boardKind: kind }));
    },
    [router, returnTo, source],
  );
  const onOwn = useCallback(() => choose('home'), [choose]);
  const onGym = useCallback(() => choose('gym'), [choose]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.flex}
      contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding }]}
      testID="board-where"
    >
      <View style={styles.cards}>
        <ChoiceCard
          icon="home"
          title={t('mobile.boardWhere.own')}
          hint={t('mobile.boardWhere.ownHint')}
          onPress={onOwn}
        />
        <ChoiceCard
          icon="gym"
          title={t('mobile.boardWhere.gym')}
          hint={t('mobile.boardWhere.gymHint')}
          onPress={onGym}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingTop: spacing[4],
  },
  cards: {
    gap: spacing[3],
  },
});
