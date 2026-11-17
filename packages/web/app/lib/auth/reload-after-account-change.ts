import { detectLocale } from '../i18n/detect-locale';
import { localeHref } from '../i18n/locale-href';

// Unattended displays use a device key and show no viewer data. They reload where they are.
const RELOAD_IN_PLACE_PREFIXES = ['/kiosk/', '/embed/'];
// A beforeunload prompt can cancel the navigation. The retired page refuses every
// request, so the climber's next tap or key press tries again.
const RETRY_EVENTS = ['pointerdown', 'keydown'] as const;

export type ReloadTarget = {
  readonly location: Pick<Location, 'pathname' | 'replace' | 'reload'>;
  readonly addEventListener: (type: (typeof RETRY_EVENTS)[number], listener: () => void) => void;
};

/**
 * A page that saw another account keeps no Router Cache or private props: it
 * starts over at its locale root. Kiosk displays and embeds reload in place.
 */
export function reloadAfterAccountChange(target: ReloadTarget = window): void {
  const { locale, strippedPath } = detectLocale(target.location.pathname);
  const inPlace = RELOAD_IN_PLACE_PREFIXES.some((prefix) => strippedPath.startsWith(prefix));
  const navigate = () => (inPlace ? target.location.reload() : target.location.replace(localeHref('/', locale)));
  for (const type of RETRY_EVENTS) target.addEventListener(type, navigate);
  navigate();
}
