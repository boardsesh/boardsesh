# Italian translation glossary

Fixed terminology for Italian (`it`) translations. **Follow this for every Italian string you add or edit** — it keeps the climbing vocabulary consistent and correct. This matters most for AI-generated translations: an agent will not reliably know the right Italian climbing term, so it is written down here.

Catalogs live in `packages/shared/i18n/locales/it/` (shared by web and mobile). The English source is `en-US/`.

> **Authority:** Daniele Palombo set this terminology — native Italian speaker and climber. When a term is missing here or you are unsure, match the wording already used in the catalogs, keep the safer existing phrasing, and flag it for review rather than guessing.

## Address: **tu** throughout

Product UI uses informal **tu** (not Lei): _Cerca un blocco_, _Il tuo diario_, _Accedi al tuo account_. Imperatives in the second person singular for buttons and CTAs (_Salva_, _Riprova_, _Illumina il blocco_). Legal/privacy copy stays clear and direct in the same voice.

## A climb is a **blocco**

Every climb on a board is a **blocco** (masculine, plural _blocchi_): _12 blocchi_, _Cerca blocchi_, _questo blocco_. Do not alternate with _problema_, _via_ or _boulder_ for the same thing. A **via** is only a rope route, if a string genuinely means one.

## Never **inviare** for a climbing send

English climbing borrowed "to send" for completing a climb. Italian **inviare / inviato / invio** reads as transmitting data, not topping a boulder.

Use instead:

- **Chiuso** — status chip and default log button for a completed ascent, masculine because it agrees with _il blocco_ (verb: **chiudere**: _Ho chiuso il blocco_, _Lo chiudo al prossimo tentativo_).
- **Ripetizione / ripetizioni** — the noun for counts and stats (_12 ripetizioni per questo blocco_, _{{count}} ripetizioni_).
- **Tentativo / tentativi** — a go on a climb (_Chiuso al terzo tentativo_, _{{count}} tentativi_).
- **Flash** — status for a first-go ascent; in running text _chiuso in flash_.
- **Salita / salite** — one logbook entry (an "ascent" or "tick", sent or not): _Registra una salita_, _Salita salvata_, _ha commentato la tua salita_. Counts of sends stay _ripetizioni_.

Workout copy uses _serie_ and _ripetizioni_ for sets and reps; context keeps that apart from send counts.

| English                   | Wrong Italian                | Right Italian                          |
| ------------------------- | ---------------------------- | -------------------------------------- |
| Send (log button, status) | Invia / Send / Inviato       | Chiuso                                 |
| Sent (ascent status)      | Inviato / Chiusa             | Chiuso                                 |
| {{count}} sends           | {{count}} invii / send       | {{count}} ripetizioni                  |
| Hardest send              | Invio più duro               | Il blocco più duro chiuso              |
| Log a send                | Registra un invio            | Registra una ripetizione / Segna come chiuso |
| Sent by {{name}}          | Inviato da {{name}}          | Chiuso da {{name}}                     |
| {{count}} attempts        | {{count}} prove              | {{count}} tentativi                    |

### Lighting a climb on the board is **illuminare**

"Send to the board" (pushing holds to the LEDs) must not collide with _Chiuso_ / _ripetizione_. Use **illuminare il blocco in parete** in running copy and tooltips; short chrome can use **Illumina** or **Illumina il pannello**. Reserve **inviare** for genuinely sending data with no climb as the object: emails, bug reports, exports, session data.

## The board device is **il pannello**

Every string names the board device **pannello** (masculine — _il pannello, un pannello, il tuo pannello, i tuoi pannelli_), with masculine agreement (_il pannello connesso_, _sul pannello_, _al pannello_). Controlling the board in a session is about the pannello too: _Prendi il pannello_ / _Libera il pannello_ / _Hai il pannello_ / _Il pannello è libero_ ("Take / Release / You have the wall", "Wall's open"), and _Questo pannello non ha luci_. Only a climb that is lit stays _in parete_. Do **not** use _board_, _tavola_ or _tabellone_ for the device, and do not use _parete_ for it (_parete_ is the gym wall). Brand product names stay in English (below): _il Kilter Board_, _la MoonBoard_ keep their brand spelling.

## A spray wall is a **Spraywall** (feminine)

The same name in English, Spanish, French, German and Italian, in every string: **Spraywall**, one word and capitalized, feminine because it patterns with _la parete_: _la Spraywall, una Spraywall, questa Spraywall_, plural _le Spraywall_ (invariable, no `-s`). Articles, adjectives and pronouns agree with the feminine (_Questa Spraywall è archiviata_, _Reimpostala_).

Never: _spray wall_, _spray-wall_, _parete spray_, _muro spray_. Never a bare _parete_ or _pannello_ for the Spraywall either (_Reimposta questa parete_ → _Reimposta questa Spraywall_). **Pannello stays the word for Kilter, Tension and MoonBoard boards**; only a spray wall is a Spraywall, so a sentence about "your boards" in general keeps _pannelli_. Hold-detection copy keeps its own words (_presa_, _blocco_); only the name of the wall changes.

## Other climbing terms

| English                                                  | Italian                                       |
| -------------------------------------------------------- | --------------------------------------------- |
| attempt (on a climb)                                     | tentativo (plural tentativi)                  |
| flash                                                    | flash (in running text: chiuso in flash)      |
| climb / boulder problem                                  | blocco                                        |
| workout block (stage of a training session, not a climb) | fase (the climb is a blocco)                  |
| route                                                    | via                                           |
| grade                                                    | grado                                         |
| hold                                                     | presa (plural prese)                          |
| wall                                                     | parete                                        |
| gym / climbing gym                                       | palestra / palestra di arrampicata            |
| angle                                                    | inclinazione                                  |
| session                                                  | session (la session)                          |
| logbook                                                  | diario                                        |
| queue                                                    | coda                                          |
| setter                                                   | tracciatore / tracciatrice                    |
| climber                                                  | climber / arrampicatore, arrampicatrice       |
| playlist                                                 | playlist (la playlist)                        |
| Party Mode                                               | Modalità party                                |
| Boardsesh grade                                          | grado Boardsesh                               |
| kickboard (climb rule)                                   | kickboard                                     |
| No matching (climb rule)                                 | Vietato accoppiare (allowed: Accoppiare consentito) |
| beta video                                               | video della beta                              |
| Established 2+ (popularity filter: sent by 2+ people)    | Consolidati 2+                                |
| Unrepeated (popularity filter)                           | Mai ripetuti                                  |
| benchmark (curated reference climb)                      | Benchmark (kept in English)                   |
| campus (no feet)                                         | campus (kept in English)                      |

Kept in English by convention (technical board-config or loanwords): **layout**, **set / sets**, **beta**, **crew**, **flash**, **playlist**, **session**, **campus**, **kickboard**.

### Keep these in English (do **not** translate)

- **Brand product names:** `Kilter Board`, `Tension Board`, `MoonBoard`, `Kilter Homewall`, `Boardsesh` (trademarks — see `LEGAL.md` and the `/legal` page).
- **`aurora.card.boardSuffix` = `"Board"`** in `settings.json` when present — it renders as `{boardName} Board`.
- **JSON keys** and **ICU placeholders** (`{{board}}`, `{{count}}`, …). Only translate values. Preserve every `{{placeholder}}` and every `<tag>` used by `<Trans>` exactly.

## Grammar notes

- Plurals use i18next's `_one` / `_other` suffixes, the same keys as English. `_one` is singular (_1 blocco_), `_other` everything else (_0 blocchi_, _12 blocchi_).
- Elide articles before a vowel: _l'inclinazione_, _l'account_, _un'app_. Watch for placeholders: `{{board}}` is a brand name, so write _il {{board}}_ rather than eliding.
- Sentence case for titles and buttons (_Crea una playlist_, not _Crea Una Playlist_).
- Errors: _Impossibile salvare la salita_ or _Non è stato possibile caricare i blocchi_. Never _Non sono riuscito a…_: the app has no gender and does not speak in the first person.
- "Play next" / "Play last" on a queue are _Metti subito dopo_ / _Metti in fondo_.

## Process

- Add every new key to **all** locales (`en-US`, `es`, `fr`, `de`, `it`) — `catalog-completeness.test.ts` fails on missing keys.
- See the root `CLAUDE.md` "Internationalisation" section for the rest of the i18n workflow, and the Spanish/French/German glossary docs for the counterparts.
