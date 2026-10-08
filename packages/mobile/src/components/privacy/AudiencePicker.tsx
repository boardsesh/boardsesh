import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';

export const SOCIAL_AUDIENCES = ['public', 'followers', 'only_me'] as const;
export const SESSION_AUDIENCES = ['public', 'followers', 'invite_only'] as const;
export const BOARD_AUDIENCES = ['public', 'unlisted', 'followers', 'invite_only'] as const;

/** Inline expansion also works inside native sheets without stacking presenters. */
export function AudiencePicker<TAudience extends PrivacyResourceAudience>({
  audience,
  onChange,
  options,
  disabled = false,
  confirmPublic = false,
  reconfirmPublic = false,
  resource = false,
  label,
}: {
  audience: TAudience;
  onChange: (audience: TAudience) => void;
  options: readonly TAudience[];
  disabled?: boolean;
  confirmPublic?: boolean;
  reconfirmPublic?: boolean;
  resource?: boolean;
  label?: string;
}) {
  const { t } = useTranslation('settings');
  const { spacing, radii, systemColors, brandColors } = useTheme();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const labels: Record<PrivacyResourceAudience, string> = {
    public: t('privacy.audiences.public'),
    followers: t('privacy.audiences.followers'),
    only_me: t('privacy.audiences.onlyMe'),
    unlisted: t('privacy.audiences.unlisted'),
    invite_only: t('privacy.audiences.invited'),
  };
  const chooseAudience = async (next: TAudience) => {
    if ((next === 'public' || next === 'unlisted') && (next !== audience || reconfirmPublic) && confirmPublic) {
      if (
        !(await confirm({
          title: next === 'unlisted' ? t('privacy.publishLinkTitle') : t('privacy.publishPublicTitle'),
          message:
            next === 'unlisted'
              ? t('privacy.publishLinkMessage')
              : resource
                ? t('privacy.publishResourceMessage')
                : t('privacy.publishPublicMessage'),
          confirmLabel: next === 'unlisted' ? t('privacy.publishLink') : t('privacy.publishPublic'),
          cancelLabel: t('privacy.cancel'),
        }))
      )
        return;
    }
    onChange(next);
    setExpanded(false);
  };
  return (
    <View style={{ gap: spacing[2] }}>
      {label ? <Text variant="subheadline">{label}</Text> : null}
      <PressableSurface
        disabled={disabled}
        onPress={() => setExpanded(!expanded)}
        accessibilityLabel={t('privacy.audienceLabel', { audience: labels[audience] })}
        accessibilityState={{ disabled, expanded }}
        style={[
          styles.control,
          { padding: spacing[3], gap: spacing[2], borderRadius: radii.button, borderColor: systemColors.separator },
        ]}
      >
        <Icon name={audience === 'public' ? 'people' : 'lock'} size={18} color={systemColors.secondaryLabel} />
        <Text>{labels[audience]}</Text>
      </PressableSurface>
      {expanded && !disabled
        ? options.map((option) => (
            <PressableSurface
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: option === audience }}
              onPress={() => void chooseAudience(option)}
              style={{
                padding: spacing[3],
                borderRadius: radii.button,
                backgroundColor: systemColors.secondaryBackground,
              }}
            >
              <Text color={option === audience ? brandColors.primary : systemColors.label}>{labels[option]}</Text>
            </PressableSurface>
          ))
        : null}
    </View>
  );
}
const styles = StyleSheet.create({
  control: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
});
