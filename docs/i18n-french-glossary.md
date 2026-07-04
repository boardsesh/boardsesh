# French translation glossary

Fixed terminology for French (`fr`) translations. **Follow this for every French string you add or edit** — it keeps the climbing vocabulary consistent and correct. This matters most for AI-generated translations: an agent will not reliably know the right French climbing term, so it is written down here.

Catalogs live in `packages/shared/i18n/locales/fr/` (shared by web and mobile). The English source is `en-US/`.

> **Authority:** Alexandre Zuttre set this terminology — native French speaker and climber. When a term is missing here or you are unsure, match the wording already used in the catalogs, keep the safer existing phrasing, and flag it for review rather than guessing.

## Never « envoyer » for a climbing send

English climbing borrowed "to send" for completing a climb. French did not: **« envoyer » never means climbing something**. To a French climber, « envoyer » only means transmitting a thing (an email, a report, data), and « Envoi » as a logging label is meaningless.

Use instead:

- **enchaîné / enchaîner** — the send status and the default verb. The log button and status chips say **« Enchaîné »**; as a verb: « Enchaîner du V5 aujourd'hui », « travaillées sans les enchaîner ».
- **la croix** — the noun: a send, the tick in your logbook. Feminine, invariable in the plural: _une croix, dix croix_. « **Faire la croix** » is the standard climbing idiom for ticking a climb in the logbook; « cocher » also works for the logging action. Counts and stat labels use « croix », not « enchaînements » — « enchaînement » as a standalone noun reads route-flavoured for board bouldering.
- **réussi / réussir** — acceptable in running prose, but statuses, buttons, and filters use « Enchaîné ».

| English                   | Wrong French         | Right French                           |
| ------------------------- | -------------------- | -------------------------------------- |
| Send (log button, status) | Envoi / Envoyer      | Enchaîné                               |
| Sent (ascent status)      | Envoyé               | Enchaîné                               |
| {{count}} sends           | {{count}} envois     | {{count}} croix                        |
| Hardest send              | Envoi le plus dur    | Croix la plus dure                     |
| Log a send                | Enregistrer un envoi | Faire la croix / Enregistrer une croix |
| Sent by {{name}}          | Envoyé par {{name}}  | Enchaîné par {{name}}                  |

« Enchaîné » agrees with its noun when one is present: _un bloc enchaîné_, _mes voies enchaînées_. A bare status chip defaults to the masculine « Enchaîné ».

### Lighting a climb on the wall is « allumer »

"Send to the wall / board" (transmitting the LEDs) is technically a legitimate « envoyer », but next to climbs it collides with the climbing sense. Use **« allumer »**: « Allumer la voie au mur », « Allumer sur la board ». Reserve « envoyer » for genuinely sending data with no climb as the object: emails, bug reports, exports, session data, and BLE lighting _commands_ in technical prose (privacy policy).

## Other climbing terms

| English                 | French                                |
| ----------------------- | ------------------------------------- |
| attempt (on a climb)    | essai (verb: essayer; status: Essayé) |
| board (the device)      | la board (feminine — see below)       |
| flash                   | flash (verb: flasher; plural: flashs) |
| climb / boulder problem | bloc                                  |
| route                   | voie                                  |
| grade                   | cotation                              |
| hold                    | prise                                 |
| wall                    | mur                                   |
| logbook                 | carnet                                |
| setter                  | ouvreur / ouvreuse (verb: ouvrir)     |
| project (unsent climb)  | projet (verb: travailler)             |
| redpoint                | après travail                         |
| climber                 | grimpeur / grimpeuse                  |

« Tentative » is not a go on a climb — keep it for non-climbing attempts (login attempts, retries, rate limits). A go on a climb is « un essai ».

### Keep these in English (do **not** translate)

- **Brand product names:** `Kilter Board`, `Tension Board`, `MoonBoard`, `Kilter Homewall`, `Boardsesh` (trademarks — see `LEGAL.md` and the `/legal` page).
- **beta**, **flash**, **crew**, **playlist** — anglicisms French climbers use as-is.
- **JSON keys** (`send`, `sends`, `statSent`, …) and **ICU placeholders** (`{{board}}`, `{{sends}}`). Only translate values.

## The board device is « la board » (feminine)

Every string names the board device **« board »**, feminine: _la board, une board, les boards_, with feminine agreement (_la board connectée_, _une board trouvée_). That is what French board climbers say and how French climbing media writes it (La Fabrique Verticale: « la board », « une Kilterboard ») — it patterns with « la planche », like skate and snowboard French. Do **not** use « planche » (wrong) or « panneau » (translationese) for the device; « panneau » survives only in the UI-panel sense (« Panneau d'administration »). Brand names stay in English (above) and take feminine agreement when an article is needed: _la board Kilter_. One exception: « le Kilter Homewall » stays masculine — it reads as a wall (« le mur »), not a board.

## Process

- Add every new key to **all** locales (`en-US`, `es`, `fr`) — the catalog completeness test fails on missing keys.
- See the root `CLAUDE.md` "Internationalisation" section for the rest of the i18n workflow, and `docs/i18n-spanish-glossary.md` for the Spanish counterpart.
