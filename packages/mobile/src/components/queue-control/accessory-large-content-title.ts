/**
 * The accessory bar's own words, name then grade, for the Large Content Viewer.
 * Shared by the iOS 26 tab-bar accessory and the floating capsule so a long
 * press on either shows the same thing.
 */
export function largeContentTitle(climbName: string, formattedGrade: string | null): string {
  return formattedGrade ? `${climbName} ${formattedGrade}` : climbName;
}
