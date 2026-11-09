import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FollowIconButton } from './FollowIconButton';
import { useAuth } from '../providers/auth-provider';
import { useToast } from '../providers/toast-provider';
import { useFollowedAuthors, useToggleAuthorFollow } from '../lib/graphql/hooks/use-followed-authors';

/** Detail header only; list rows receive indexed follow state from their parent. */
export function SetterFollowButton({ username }: { username: string }) {
  const { t } = useTranslation('climbs');
  const { showToast } = useToast();
  const { isAuthenticated } = useAuth();
  const follows = useFollowedAuthors();
  const toggle = useToggleAuthorFollow();
  // `isSuccess` outlives the save: left set, a later background refetch would
  // bring back this tap's result over whatever the follow list says by then.
  const saveSettled = toggle.isSuccess && !follows.isFetching;
  const { reset: resetToggle } = toggle;
  useEffect(() => {
    if (saveSettled) resetToggle();
  }, [saveSettled, resetToggle]);
  if (!isAuthenticated) return null;

  // The icon is the only feedback, so it shows the tap's result straight away
  // and holds it through the refetch that follows a save.
  const showTappedState = toggle.isPending || (toggle.isSuccess && follows.isFetching);
  const following = showTappedState ? toggle.variables.follow : follows.setterNames.has(username);

  return (
    <FollowIconButton
      isFollowing={following}
      disabled={toggle.isPending || (!follows.data && !follows.isError)}
      onToggle={() => {
        if (!follows.data) {
          showToast(t('authors.syncNeeded'), 'error');
          return;
        }
        toggle.mutate(
          { kind: 'setter', identifier: username, follow: !following },
          { onError: () => showToast(t('authors.followError'), 'error') },
        );
      }}
    />
  );
}
