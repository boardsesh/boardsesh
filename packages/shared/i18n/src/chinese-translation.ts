/** Only Simplified Chinese is translated; Mandarin is the language, not a script. */
export function isChineseTranslationLocale(locale: string): boolean {
  return locale.toLowerCase() === 'zh-cn';
}

/** An unset form stays unavailable rather than sending climbers to a placeholder. */
export function getChineseTerminologyFormUrl(configuredUrl: string | undefined): string | null {
  if (!configuredUrl?.trim()) return null;
  try {
    const url = new URL(configuredUrl.trim());
    const isGoogleForm =
      (url.hostname === 'forms.gle' && url.pathname.length > 1) ||
      (url.hostname === 'docs.google.com' && url.pathname.startsWith('/forms/'));
    return url.protocol === 'https:' && !url.username && !url.password && isGoogleForm ? url.href : null;
  } catch {
    return null;
  }
}

/** Publishing the form gives people who saw the early welcome one invitation. */
export function chineseTranslationOnboardingKey(formUrl: string | null): string {
  return formUrl ? 'onboarding_chinese_translation_form_v1' : 'onboarding_chinese_translation_intro_v1';
}
