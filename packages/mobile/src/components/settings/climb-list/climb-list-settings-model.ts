import type { ReactNode } from 'react';
import type { MoreFormModel, MoreToggleRow } from '../../MoreForm.types';
import type { ClimbRowDisplay, ClimbRowFieldId, ClimbRowPresetId } from '../../../lib/climb-row-display';

type Translation = (key: string, options?: Record<string, unknown>) => string;
export function climbRowPresetLabel(preset: ClimbRowPresetId | 'custom', t: Translation): string {
  return t(`mobile.settings.climbList.presets.${preset}`);
}
export function buildClimbListSettingsModel(input: {
  display: ClimbRowDisplay;
  setField: (field: ClimbRowFieldId, enabled: boolean) => void;
  t: Translation;
  preview: ReactNode;
  previewHeight: number;
}): MoreFormModel {
  const { display, setField, t } = input;
  const toggle = (field: ClimbRowFieldId, label: string, subtitle?: string): MoreToggleRow => ({
    kind: 'toggle',
    key: field,
    label,
    subtitle,
    value: display[field],
    onValueChange: (enabled) => setField(field, enabled),
  });
  return {
    sections: [
      {
        key: 'preview',
        footer: t('mobile.settings.climbList.previewFooter'),
        rows: [
          {
            kind: 'custom',
            key: 'climbRowPreview',
            content: input.preview,
            height: input.previewHeight,
            fullBleed: true,
          },
        ],
      },
      {
        key: 'picture',
        title: t('mobile.settings.climbList.picture'),
        rows: [toggle('thumbnail', t('mobile.settings.climbList.fields.thumbnail'))],
      },
      {
        key: 'underName',
        title: t('mobile.settings.climbList.underName'),
        footer: t('mobile.settings.climbList.gradeFooter'),
        rows: [
          toggle('communityGrade', t('mobile.settings.climbList.fields.communityGrade')),
          toggle('sends', t('mobile.settings.climbList.fields.sends')),
          toggle('rating', t('mobile.settings.climbList.fields.rating')),
          toggle('setter', t('mobile.settings.climbList.fields.setter')),
        ],
      },
      {
        key: 'yourClimbing',
        title: t('mobile.settings.climbList.yourClimbing'),
        footer: t('mobile.settings.climbList.personalFooter'),
        rows: [
          toggle('sentMark', t('mobile.settings.climbList.fields.sentMark')),
          toggle('progress', t('mobile.settings.climbList.fields.progress')),
          toggle(
            'playlistTags',
            t('mobile.settings.climbList.fields.playlistTags'),
            t('mobile.settings.climbList.playlistTagsDescription'),
          ),
        ],
      },
      {
        key: 'actions',
        title: t('mobile.settings.climbList.actions'),
        rows: [
          toggle(
            'quickActions',
            t('mobile.settings.climbList.fields.quickActions'),
            t('mobile.settings.climbList.quickActionsDescription'),
          ),
        ],
      },
    ],
  };
}
