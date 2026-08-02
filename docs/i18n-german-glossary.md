# German translation glossary

Fixed terminology for German (`de`) translations. **Follow this for every German string you add or edit** — it keeps the climbing vocabulary consistent and correct. This matters most for AI-generated translations: an agent will not reliably know the right German climbing term, so it is written down here.

Catalogs live in `packages/shared/i18n/locales/de/` (shared by web and mobile). The English source is `en-US/`.

> **Authority:** Axel Perschmann set this terminology — native German speaker and climber. When a term is missing here or you are unsure, match the wording already used in the catalogs, keep the safer existing phrasing, and flag it for review rather than guessing.

## Address: **du** throughout

Product UI uses informal **du** (not Sie). Legal/privacy copy stays clear and direct in the same voice unless a statute requires otherwise.

## Inclusive language: gender star

Use the gender star for role nouns: **Routenbauer\*in**, **Kletterer\*in**. Prefer neutral rewrites in long sentences when a starred form would get ugly. Do not mix with colon forms (`:in`) or Binnen-I.

## Never **senden** for a climbing send

English climbing borrowed "to send" for completing a climb. German **senden / Sendung / gesendet** reads as transmitting data, not topping a boulder.

Use instead:

- **Getoppt** — status chip and default log button for a completed ascent (verb: **toppen**).
- **Begehung / Begehungen** — the noun for counts and stats (`{{count}} Begehungen`, hardest send → schwerste Begehung).
- Never calque **Send / Sends / gesendet** for ascents.

| English                   | Wrong German                | Right German                            |
| ------------------------- | --------------------------- | --------------------------------------- |
| Send (log button, status) | Senden / Send / Gesendet    | Getoppt                                 |
| Sent (ascent status)      | Gesendet                    | Getoppt                                 |
| {{count}} sends           | {{count}} Sends / Sendungen | {{count}} Begehungen                    |
| Hardest send              | Schwerster Send             | Schwerste Begehung                      |
| Log a send                | Send loggen                 | Begehung eintragen / Als getoppt loggen |
| Sent by {{name}}          | Gesendet von {{name}}       | Getoppt von {{name}}                    |

### Lighting a climb on the board is **beleuchten**

"Send to the board" (pushing holds to the LEDs) must not collide with Getoppt/Begehung. Prefer **Boulder am Board beleuchten** in running copy and tooltips; short chrome can use **Board beleuchten**. Do **not** use « Boulder auf die Board beleuchten » or « auf das Board beleuchten ». Reserve **senden** for genuinely sending data with no climb as the object: emails, bug reports, exports, session data.

## The board device is **Board** (neuter)

Every string names the board device **Board**, neuter in grammar: _das Board, ein Board, dein Board, deine Boards_, with neuter agreement (_das verbundene Board_, _ein gefundenes Board_, _an dem Board_ / _am Board_). Same for compounds (_das Kletterboard_, _jedes Trainingsboard_). Do **not** use Wand for the device (Wand is the gym wall). Brand product names stay in English (below).

## Other climbing terms

| English                 | German                                      |
| ----------------------- | ------------------------------------------- |
| attempt (on a climb)    | Versuch (verb: versuchen; status: Versucht) |
| flash                   | Flash (verb: flashen; status: Geflasht)     |
| climb / boulder problem | Boulder                                     |
| route                   | Route                                       |
| grade                   | Grad                                        |
| hold                    | Griff                                       |
| wall                    | Wand                                        |
| gym / climbing gym      | Halle / Kletterhalle                        |
| angle                   | Winkel                                      |
| session                 | Session                                     |
| logbook                 | Routenbuch                                  |
| queue                   | Warteschlange                               |
| setter                  | Routenbauer\*in                             |
| climber                 | Kletterer\*in                               |
| playlist                | Playlist                                    |
| Party Mode              | Party-Modus                                 |
| Boardsesh grade         | Boardsesh-Grad                              |

« Tentative »-style false friends: a go on a climb is **Versuch**, not a login/retry "attempt" calqued oddly. Login/rate-limit attempts can still use Versuch where natural German already does.

Kept in English by convention (technical board-config or loanwords): **layout**, **set / sets**, **beta**, **crew**, **Flash** (as the status word), **Playlist**, **Session**, **Board**.

### Keep these in English (do **not** translate)

- **Brand product names:** `Kilter Board`, `Tension Board`, `MoonBoard`, `Kilter Homewall`, `Boardsesh` (trademarks — see `LEGAL.md` and the `/legal` page).
- **`aurora.card.boardSuffix` = `"Board"`** in `settings.json` when present — it renders as `{boardName} Board`.
- **JSON keys** and **ICU placeholders** (`{{board}}`, `{{count}}`, …). Only translate values. Preserve every `{{placeholder}}` exactly.

## Process

- Add every new key to **all** locales (`en-US`, `es`, `fr`, `de`) — `catalog-completeness.test.ts` fails on missing keys.
- See the root `CLAUDE.md` "Internationalisation" section for the rest of the i18n workflow, and the Spanish/French glossary docs for the counterparts.
