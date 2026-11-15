import { ONBOARDING_TIP_RECORD_KEY } from '@boardsesh/key-value-storage';
import { memo, useCallback, useEffect, useState } from 'react';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useHideOnScroll } from '../../hooks/use-hide-on-scroll';
import { useListTopOffset } from '../../hooks/use-list-top-offset';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import type { useYouProfileData } from '../../lib/graphql/hooks';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { BoardLinkPrompt } from './BoardLinkPrompt';
import { ProfileBetaShelf } from './ProfileBetaShelf';
import { ProgressView } from './ProgressView';

type ProgressTabProps = {
  data: ReturnType<typeof useYouProfileData>;
  topInset: number;
  userId?: string;
  onOpenFilters?: () => void;
  isOwnProfile?: boolean;
  scrollEdge?: ScrollEdgeBackdrop;
};

/** Production adapter: owns persistent tips and connected optional sections. */
export const ProgressTab = memo(function ProgressTab({
  data,
  userId,
  isOwnProfile = true,
  scrollEdge,
  ...props
}: ProgressTabProps) {
  const nativeRootHeader = useNativeRootHeader();
  const listTopOffset = useListTopOffset();
  const onScroll = useHideOnScroll(scrollEdge?.listProps.onScroll);
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const [recordTipVisible, setRecordTipVisible] = useState(false);
  const hasSends = data.totalsStatus === 'ready' && data.statisticsSummary.totalAscents > 0;
  useEffect(() => {
    if (!hasSends) return;
    let cancelled = false;
    void hasSeenTip(ONBOARDING_TIP_RECORD_KEY).then((seen) => {
      if (!cancelled && !seen) setRecordTipVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSends]);
  const dismissRecordTip = useCallback(() => {
    setRecordTipVisible(false);
    void markTipSeen(ONBOARDING_TIP_RECORD_KEY);
  }, []);
  return (
    <ProgressView
      {...props}
      data={data}
      isOwnProfile={isOwnProfile}
      scrollEdge={scrollEdge}
      nativeRootHeader={nativeRootHeader}
      listTopOffset={listTopOffset}
      onScroll={onScroll}
      bottomInset={scrollBottomPadding}
      recordTipVisible={recordTipVisible}
      onDismissRecordTip={dismissRecordTip}
      betaShelf={userId ? <ProfileBetaShelf userId={userId} /> : undefined}
      boardLinkPrompt={
        <BoardLinkPrompt key={userId} viewerIsOwner={isOwnProfile} hasNoSends={!data.hasActiveFilters} />
      }
    />
  );
});
