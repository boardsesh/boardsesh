import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';

/** Every section switched off. The header buttons stay, so notifications and find climbers still work. */
export function HomeEmptyState({ onCustomize }: { onCustomize: () => void }) {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  return (
    <EmptyState
      size="section"
      icon="home"
      title={t('mobile.home.sections.empty.title')}
      body={t('mobile.home.sections.empty.body')}
      actions={
        <Button
          title={tCommon('mobile.settings.homeSections.customize')}
          icon="view.options"
          onPress={onCustomize}
          testID="home-empty-customize"
        />
      }
      testID="home-empty"
    />
  );
}
