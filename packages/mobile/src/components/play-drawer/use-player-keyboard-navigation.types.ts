export type PlayerKeyboardNavigationOptions = {
  enabled: boolean;
  label?: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onEscape?: () => void;
};
