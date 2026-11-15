import { memo } from 'react';
import { selectEffectiveOffline, useConnectivityField } from '../lib/connectivity/use-connectivity';
import { OfflineStateView, type OfflineStateViewProps } from './OfflineStateView';
export { OfflineStateView } from './OfflineStateView';
type OfflineStateProps = Omit<OfflineStateViewProps, 'effectiveOffline'>;
export const OfflineState = memo(function OfflineState(props: OfflineStateProps) {
  const effectiveOffline = useConnectivityField(selectEffectiveOffline);
  return <OfflineStateView {...props} effectiveOffline={effectiveOffline} />;
});
