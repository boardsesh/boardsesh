import type { MoreRow, MoreSection } from './MoreForm.types';

/**
 * The climb-name search: a text field with an inline clear button. The settings
 * row kinds (MoreForm.types) have no text field, so the Filters form adds it.
 */
export type FilterNameRow = {
  kind: 'name';
  key: string;
  value: string;
  placeholder: string;
  /** VoiceOver name for the field (it has no visible label). */
  accessibilityLabel: string;
  /** VoiceOver name for the inline clear button. */
  clearLabel: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
  /** Fired when the field gains focus, so the sheet can rise to its tall detent. */
  onFocus: () => void;
};

/**
 * A menu of one-shot actions shown as a settings row: the recent searches. Picking
 * an item runs it; the item in force carries a checkmark.
 */
export type FilterMenuRow = {
  kind: 'menu';
  key: string;
  label: string;
  /** Trailing value, e.g. the search in force. */
  value?: string;
  items: { key: string; label: string; checked: boolean }[];
  onSelect: (key: string) => void;
};

export type ClimbFilterFormRow = MoreRow | FilterNameRow | FilterMenuRow;

export type ClimbFilterFormSection = Omit<MoreSection, 'rows'> & { rows: ClimbFilterFormRow[] };

export type ClimbFilterFormModel = {
  sections: ClimbFilterFormSection[];
};

export type ClimbFilterFormProps = {
  model: ClimbFilterFormModel;
};
