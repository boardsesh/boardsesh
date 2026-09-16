import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Text } from './Text';
import { useAuth } from '../providers/auth-provider';
import { useFollowedAuthors, useToggleAuthorFollow } from '../lib/graphql/hooks/use-followed-authors';

/** Detail header only; list rows receive indexed follow state from their parent. */
export function SetterFollowButton({ username }: { username: string }) {
  const { t } = useTranslation('climbs');
  const { isAuthenticated } = useAuth();
  const follows = useFollowedAuthors();
  const toggle = useToggleAuthorFollow();
  if (!isAuthenticated) return <Text variant="footnote">{t('authors.signIn')}</Text>;
  const following = follows.setterNames.has(username);
  return (
    <>
      <Button
        title={following ? t('authors.unfollow') : t('authors.follow')}
        disabled={!follows.data || toggle.isPending}
        onPress={() => toggle.mutate({ kind: 'setter', identifier: username, follow: !following })}
      />
      {toggle.isError || follows.isError ? <Text variant="footnote">{t('authors.syncNeeded')}</Text> : null}
    </>
  );
}
