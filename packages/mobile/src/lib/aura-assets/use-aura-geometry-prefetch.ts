import { useEffect } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { parseOfflineBoardKey } from '@boardsesh/offline-sync';
import { climbOverlayGeometryAssetApiVersion } from '../../../modules/climb-overlay-gpu/src';
import { useSetting } from '../../settings';
import { auraGeometryCache, auraGeometryManifest, rememberAuraOfflineScopes } from './native-store';
import type { AuraGeometryScope } from './manifest';

/** No UI state: completing this optional transfer cannot restart a gesture. */
export function useAuraGeometryPrefetch(selected: AuraGeometryScope | null | undefined): void {
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const boardType = selected?.boardType;
  const layoutId = selected?.layoutId;
  const sizeId = selected?.sizeId;
  useEffect(() => {
    if (climbOverlayGeometryAssetApiVersion < 1) return;
    const offline = enabledScopeKeys.flatMap((key) => {
      const scope = parseOfflineBoardKey(key);
      return scope ? [scope] : [];
    });
    rememberAuraOfflineScopes(offline);
    if (auraGeometryManifest.assets.length === 0) return;
    const current =
      boardType && layoutId !== undefined && sizeId !== undefined ? { boardType, layoutId, sizeId } : null;
    let mounted = true;
    const prefetch = () => {
      if (!mounted || AppState.currentState !== 'active') return;
      void auraGeometryCache.prefetch(current, offline);
    };
    prefetch();
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      if (
        state.isConnected === false ||
        state.isInternetReachable === false ||
        state.type === 'cellular' ||
        state.details?.isConnectionExpensive === true
      ) {
        auraGeometryCache.stop();
      } else {
        prefetch();
      }
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') prefetch();
      else auraGeometryCache.stop();
    });
    return () => {
      mounted = false;
      unsubscribeNetwork();
      subscription.remove();
      auraGeometryCache.stop();
    };
  }, [boardType, layoutId, sizeId, enabledScopeKeys]);
}
