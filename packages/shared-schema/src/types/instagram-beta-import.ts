// Hand-written TS mirrors of the instagramBetaScan SDL types (matches the
// project convention of authoring request/response types by hand rather than
// importing the codegen output — see ticks.ts / AttachBetaLinkInput).

export type InstagramScanPostInput = {
  shortcode: string;
  caption?: string | null;
  takenAt?: string | null;
};

export type InstagramBetaScanInput = {
  boardType: string;
  posts: InstagramScanPostInput[];
};

export type InstagramBetaMatch = {
  shortcode: string;
  link: string;
  climbUuid: string;
  climbName: string;
  boardType: string;
  angle: number | null;
};

export type InstagramBetaCandidate = {
  climbUuid: string;
  name: string;
  layoutId: number;
  setterUsername: string | null;
};

export type InstagramBetaAmbiguous = {
  shortcode: string;
  link: string;
  parsedName: string;
  boardType: string;
  angle: number | null;
  candidates: InstagramBetaCandidate[];
};

export type InstagramBetaUnmatched = {
  shortcode: string;
  link: string;
  parsedName: string | null;
  /** 'no-caption' | 'not-parsed' | 'no-climb' */
  reason: string;
};

export type InstagramBetaScanResult = {
  scanned: number;
  parsed: number;
  missing: InstagramBetaMatch[];
  alreadyLinked: InstagramBetaMatch[];
  ambiguous: InstagramBetaAmbiguous[];
  unmatched: InstagramBetaUnmatched[];
};
