import { useCallback, useEffect, useState } from 'react';
import type { PrivacyAudience, PrivacyPublicationInput } from '@boardsesh/graphql/operations/privacy';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';

/** A deliberate audience choice is bound to the settings revision when made. */
export function usePublicationAudience(identity: string, active = true, existing?: { audience?: PrivacyAudience }) {
  const { data: settings } = usePrivacySettings();
  const [selection, setSelection] = useState<{ identity: string; publication: PrivacyPublicationInput } | null>(null);
  useEffect(() => {
    if (!active) setSelection(null);
  }, [active]);
  const choice = selection?.identity === identity ? selection.publication : undefined;
  const audience: PrivacyAudience =
    choice?.audience ?? existing?.audience ?? (settings?.isPrivate ? 'followers' : 'public');
  const chooseAudience = useCallback(
    (next: PrivacyAudience) => {
      if (!settings?.enabled) return;
      setSelection({ identity, publication: { audience: next, privacyRevision: settings.privacyRevision } });
    },
    [identity, settings],
  );
  return {
    enabled: settings?.enabled === true,
    isPrivate: settings?.isPrivate === true,
    revisionChanged: !!choice && !!settings && choice.privacyRevision !== settings.privacyRevision,
    audience,
    chooseAudience,
    // The server validates this revision before publishing; stale queued choices
    // can never override an account that became private on another device.
    publication: settings?.enabled
      ? (choice ?? (existing ? undefined : { audience, privacyRevision: settings.privacyRevision }))
      : undefined,
  };
}
