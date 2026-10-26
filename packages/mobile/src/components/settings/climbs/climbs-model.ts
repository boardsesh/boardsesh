import type { GradeDisplayFormat } from '@boardsesh/play-view';
import type { MoreFormModel, MoreOption, MoreRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

/** The grade formats, labelled. Also the Settings root's value for the Climbs & grades row. */
export function gradeFormatOptions(t: SettingsTranslate): (MoreOption & { key: GradeDisplayFormat })[] {
  return [
    { key: 'v-grade', label: t('mobile.settings.gradeFormat.vGrade') },
    { key: 'font', label: t('mobile.settings.gradeFormat.font') },
    { key: 'both', label: t('mobile.settings.gradeFormat.both') },
  ];
}

export type ClimbsModelInput = {
  t: SettingsTranslate;
  gradeFormat: GradeDisplayFormat;
  onGradeFormatChange: (format: GradeDisplayFormat) => void;
  /** The RESOLVED value: the climber's choice, else the `personal-grades` flag's default. */
  personalGrades: boolean;
  onPersonalGradesChange: (enabled: boolean) => void;
  /** `null` while the Boardsesh grade is flagged off: no row at all. */
  boardseshGrades: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
  /** The climb-list preset the climber is on ("Default", "Custom"…). */
  climbListPresetLabel: string;
  onOpenClimbList: () => void;
  /** "Default", or "Custom" once the player's buttons or the sections below the climb changed. */
  climbViewLabel: string;
  onOpenClimbView: () => void;
  /** "Default", or "Custom" once a list's quick-filter chips or their order changed. */
  quickFiltersLabel: string;
  onOpenQuickFilters: () => void;
};

/**
 * "Climbs & grades": how grades read, what the climb list shows, how the climb
 * view is laid out, and which quick filters sit above a list. Everything here
 * changes how climbs look, so it lives together.
 */
export function buildClimbsModel(input: ClimbsModelInput): MoreFormModel {
  const { t } = input;
  const formats = gradeFormatOptions(t);

  const gradeRows: MoreRow[] = [
    {
      kind: 'segmented',
      key: 'gradeFormat',
      label: t('mobile.settings.gradeFormat.title'),
      options: formats,
      selectedKey: input.gradeFormat,
      onSelect: (key) => {
        const next = formats.find((option) => option.key === key);
        if (next) input.onGradeFormatChange(next.key);
      },
    },
    {
      kind: 'toggle',
      key: 'personalGrades',
      label: t('mobile.settings.displayOptions.personalGrades'),
      subtitle: t('mobile.settings.displayOptions.personalGradesDescription'),
      value: input.personalGrades,
      onValueChange: input.onPersonalGradesChange,
    },
  ];
  if (input.boardseshGrades) {
    gradeRows.push({
      kind: 'toggle',
      key: 'boardseshGrades',
      label: t('mobile.settings.displayOptions.boardseshGrades'),
      subtitle: t('mobile.settings.displayOptions.boardseshGradesDescription'),
      value: input.boardseshGrades.enabled,
      onValueChange: input.boardseshGrades.onChange,
    });
  }

  return {
    sections: [
      {
        key: 'grades',
        title: t('mobile.settings.climbList.gradesTitle'),
        footer: t('mobile.settings.gradeFormat.description'),
        rows: gradeRows,
      },
      {
        key: 'climbList',
        rows: [
          {
            kind: 'nav',
            key: 'climbList',
            label: t('mobile.settings.climbList.title'),
            value: input.climbListPresetLabel,
            badge: t('userDrawer.newBadge'),
            onPress: input.onOpenClimbList,
          },
          {
            kind: 'nav',
            key: 'climbView',
            label: t('mobile.settings.climbView.title'),
            value: input.climbViewLabel,
            onPress: input.onOpenClimbView,
          },
          {
            kind: 'nav',
            key: 'quickFilters',
            label: t('mobile.settings.quickFilters.title'),
            value: input.quickFiltersLabel,
            onPress: input.onOpenQuickFilters,
          },
        ],
      },
    ],
  };
}
