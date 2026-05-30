export type PartyProfile = {
  /** UUID generated on first launch. Stable per device per uninstall. */
  id: string;
};

export type PartyProfileStorage = {
  get(): Promise<PartyProfile | null>;
  set(profile: PartyProfile): Promise<void>;
};
