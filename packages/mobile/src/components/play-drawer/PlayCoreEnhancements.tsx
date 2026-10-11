import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePrivacyCredentialScope } from '../../hooks/use-privacy-scoped-state';
import { useFavoriteStatus, useProfile, useToggleFavorite } from '../../lib/graphql/hooks';
import {
  getPrivacyCredentialGeneration,
  getPrivacyRevocationGeneration,
  subscribeToPrivacyRevocations,
} from '../../lib/privacy/privacy-cache';

type ToggleFavoriteMutate = ReturnType<typeof useToggleFavorite>['mutate'];

export function getPlayCoreEnhancementTargetKey(boardName: string, climbUuid: string | null, angle: number): string {
  return JSON.stringify([boardName, climbUuid, angle]);
}

export type PlayCoreEnhancementSnapshot = {
  targetKey: string;
  boardName: string;
  climbUuid: string | null;
  angle: number;
  privacyGeneration: number;
  credentialGeneration: number;
  currentUserId: string | null;
  serverFavorited: boolean | undefined;
  toggleFavoriteMutate: ToggleFavoriteMutate;
};

type PlayCoreEnhancementsProps = {
  boardName: string;
  climbUuid: string | null;
  angle: number;
  enabled: boolean;
  onSnapshot: (snapshot: PlayCoreEnhancementSnapshot | null) => void;
};

/** Query observers and favorite mutation wiring mount after the interactive core. */
export function PlayCoreEnhancements({ boardName, climbUuid, angle, enabled, onSnapshot }: PlayCoreEnhancementsProps) {
  const privacyGeneration = useSyncExternalStore(
    subscribeToPrivacyRevocations,
    getPrivacyRevocationGeneration,
    getPrivacyRevocationGeneration,
  );
  const credentialGeneration = usePrivacyCredentialScope();
  const targetKey = getPlayCoreEnhancementTargetKey(boardName, climbUuid, angle);
  const callbackScope = useMemo(
    () => ({ targetKey, privacyGeneration, credentialGeneration, enabled }),
    [targetKey, privacyGeneration, credentialGeneration, enabled],
  );
  const currentScopeRef = useRef(callbackScope);
  currentScopeRef.current = callbackScope;
  const mountedRef = useRef(false);
  const { data: profile } = useProfile({ enabled });
  const { data: serverFavorited } = useFavoriteStatus(boardName, climbUuid, angle, { enabled });
  const { mutate } = useToggleFavorite();
  const currentUserId = profile?.id ?? null;

  const toggleFavoriteMutate = useCallback<ToggleFavoriteMutate>(
    (variables, options) => {
      const scopeIsCurrent = () => {
        const currentScope = currentScopeRef.current;
        return (
          mountedRef.current &&
          currentScope === callbackScope &&
          enabled &&
          currentScope.enabled &&
          currentScope.targetKey === targetKey &&
          currentScope.privacyGeneration === privacyGeneration &&
          currentScope.credentialGeneration === credentialGeneration &&
          getPrivacyRevocationGeneration() === privacyGeneration &&
          getPrivacyCredentialGeneration() === credentialGeneration
        );
      };
      if (
        !scopeIsCurrent() ||
        !climbUuid ||
        variables.input.boardName !== boardName ||
        variables.input.climbUuid !== climbUuid ||
        variables.input.angle !== angle
      )
        return;
      mutate(
        variables,
        options
          ? {
              ...options,
              onSuccess: (...callbackArguments) => {
                if (scopeIsCurrent()) options.onSuccess?.(...callbackArguments);
              },
              onError: (...callbackArguments) => {
                if (scopeIsCurrent()) options.onError?.(...callbackArguments);
              },
              onSettled: (...callbackArguments) => {
                if (scopeIsCurrent()) options.onSettled?.(...callbackArguments);
              },
            }
          : undefined,
      );
    },
    [mutate, boardName, climbUuid, angle, targetKey, enabled, privacyGeneration, credentialGeneration, callbackScope],
  );

  useEffect(() => {
    mountedRef.current = true;
    const scope = currentScopeRef.current;
    if (
      !enabled ||
      scope.targetKey !== targetKey ||
      getPrivacyRevocationGeneration() !== privacyGeneration ||
      getPrivacyCredentialGeneration() !== credentialGeneration
    ) {
      onSnapshot(null);
    } else {
      onSnapshot({
        targetKey,
        boardName,
        climbUuid,
        angle,
        privacyGeneration,
        credentialGeneration,
        currentUserId,
        serverFavorited,
        toggleFavoriteMutate,
      });
    }
    return () => {
      mountedRef.current = false;
      onSnapshot(null);
    };
  }, [
    onSnapshot,
    targetKey,
    boardName,
    climbUuid,
    angle,
    enabled,
    privacyGeneration,
    credentialGeneration,
    currentUserId,
    serverFavorited,
    toggleFavoriteMutate,
  ]);

  return null;
}
