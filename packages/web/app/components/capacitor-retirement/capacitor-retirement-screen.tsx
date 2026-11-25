'use client';

import { useTranslation } from 'react-i18next';
import CapacitorRetirementContent from './capacitor-retirement-content';

export function CapacitorRetirementScreen() {
  const { t } = useTranslation('common');
  return (
    <CapacitorRetirementContent
      copy={{
        title: t('capacitorRetirement.title'),
        description: t('capacitorRetirement.description'),
        cta: t('capacitorRetirement.cta'),
        fallbackCta: t('capacitorRetirement.fallbackCta'),
      }}
    />
  );
}

export default CapacitorRetirementScreen;
