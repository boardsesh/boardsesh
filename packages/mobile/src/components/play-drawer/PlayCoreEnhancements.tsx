import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePrivacyCredentialScope } from '../../hooks/use-privacy-scoped-state';
import { useFavoriteStatus, useToggleFavorite } from '../../lib/graphql/hooks';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';

type ToggleFavoriteMutate = ReturnType<typeof useToggleFavorite>['mutate'];

export function getPlayCoreEnhancementTargetKey(boardName: string, climbUuid: string | null, angle: number): string {
  return JSON.stringify([boardName, climbUuid, angle]);
}

export type PlayCoreEnhancementSnapshot = {
  targetKey: string;
  boardName: string;
  climbUuid: string | null;
  angle: number;
  credentialGeneration: number;
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
  const credentialGeneration = usePrivacyCredentialScope();
  const targetKey = getPlayCoreEnhancementTargetKey(boardName, climbUuid, angle);
  const callbackScope = useMemo(
    () => ({ targetKey, credentialGeneration, enabled }),
    [targetKey, credentialGeneration, enabled],
  );
  const currentScopeRef = useRef(callbackScope);
  currentScopeRef.current = callbackScope;
  const mountedRef = useRef(false);
  const { data: serverFavorited } = useFavoriteStatus(boardName, climbUuid, angle, { enabled });
  const { mutate } = useToggleFavorite();

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
          currentScope.credentialGeneration === credentialGeneration &&
          getCredentialGeneration() === credentialGeneration
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
    [mutate, boardName, climbUuid, angle, targetKey, enabled, credentialGeneration, callbackScope],
  );

  useEffect(() => {
    mountedRef.current = true;
    const scope = currentScopeRef.current;
    if (!enabled || scope.targetKey !== targetKey || getCredentialGeneration() !== credentialGeneration) {
      onSnapshot(null);
    } else {
      onSnapshot({
        targetKey,
        boardName,
        climbUuid,
        angle,
        credentialGeneration,
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
    credentialGeneration,
    serverFavorited,
    toggleFavoriteMutate,
  ]);

  return null;
}
