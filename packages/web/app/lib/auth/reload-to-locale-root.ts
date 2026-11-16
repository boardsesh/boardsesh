import { detectLocale } from '../i18n/detect-locale';
import { localeHref } from '../i18n/locale-href';

/** A page that saw another account keeps no Router Cache or private props: start over at its locale root. */
export function reloadToLocaleRoot(): void {
  window.location.replace(localeHref('/', detectLocale(window.location.pathname).locale));
}
