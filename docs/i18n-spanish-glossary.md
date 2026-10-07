# Spanish translation glossary

Fixed terminology for Spanish (`es`) translations. **Follow this for every Spanish string you add or edit** — it keeps the climbing vocabulary consistent and correct. This matters most for AI-generated translations: an agent will not reliably know the right Spanish climbing term, so it is written down here.

Catalogs live in `packages/shared/i18n/locales/es/` (shared by web and mobile). The English source is `en-US/`.

> **Authority:** Alex Sánchez set this terminology — native Spanish speaker and climber. When a term is missing here or you are unsure, match the wording already used in the catalogs, keep the safer existing phrasing, and flag it for review rather than guessing.

## The board is a **plafón**

A climbing board is always **`plafón`** in Spanish.

- Masculine: **el** plafón, **un** plafón (never _la tabla_ / _una tabla_).
- Plural: **plafones** (los plafones, unos plafones).
- It replaces every previous variant: `tabla de escalada`, `tabla de entrenamiento`, `tablero`, bare `tabla` (board sense), and raw English `board` / `boards` left untranslated in Spanish strings.

Fix the surrounding grammar when you swap the word — articles and adjectives have to agree:

| Before                                   | After                                      |
| ---------------------------------------- | ------------------------------------------ |
| la tabla / esta tabla                    | el plafón / este plafón                    |
| una tabla                                | un plafón                                  |
| de la tabla / a la tabla                 | del plafón / al plafón                     |
| las tablas / estas tablas                | los plafones / estos plafones              |
| todas tus tablas                         | todos tus plafones                         |
| una tabla estandarizada                  | un plafón estandarizado                    |
| tablas ... estandarizadas / interactivas | plafones ... estandarizados / interactivos |

### Keep these in English (do **not** translate)

- **Brand product names:** `Kilter Board`, `Tension Board`, `MoonBoard`, `Kilter Homewall`, `Boardsesh`. These are trademarks (see `LEGAL.md` and the `/legal` page) — translating them would imply a product that does not exist and weakens the trademark wording.
- **`aurora.card.boardSuffix` = `"Board"`** in `settings.json`. It renders as `{boardName} Board` → "Kilter Board" / "Tension Board", so it must stay English.
- **JSON keys** (`board`, `boardTypeLabel`, `boardsTitle`, …) and **ICU placeholders** (`{{board}}`, which interpolates a board's name). Only translate values.

## The gym is a **rocódromo**

Every gym in Boardsesh is a climbing gym, so the word is always **`rocódromo`** — never `gimnasio`, which is the generic fitness gym. There is no conditional: if a Spanish string names the place where the wall lives, it says rocódromo.

- Masculine, like `gimnasio`, so articles and adjectives stay put: **el** rocódromo, **un** rocódromo, **del/al** rocódromo, **este** rocódromo.
- Plural: **rocódromos** (los rocódromos, tus rocódromos).
- Capitalise it the same way the old word was capitalised: sentence-initial `Gimnasio` → `Rocódromo`.

Two things it does **not** touch:

- **URLs, slugs and email examples drop the accent** — `hola@rocodromo.com`, `https://turocodromo.com`, `tu-rocodromo`. Accented characters do not belong in a placeholder someone is meant to type into a URL or address field.
- **`plafón` is a different word.** The board is the plafón, the building is the rocódromo. A find/replace that turns one into the other is a bug — `gym-term-consistency.test.ts` guards both directions.

## A spray wall is a **Spraywall** (untranslated)

One name for a user-built spray wall, in every string: **Spraywall**, left in English because Spanish has no good translation. Masculine: _el Spraywall, un Spraywall, este Spraywall_, plural _los Spraywalls_ (add `-s`, no accent, no hyphen). Articles, adjectives and pronouns agree with the masculine (_Este Spraywall está archivado_, _Resetéalo_). Capitalised like a brand-neutral proper noun in running text and titles.

Never: _plafón de spray_, _plafones de spray_, _plafón spray_, _plafón de presas_, _muro de spray_, _muro spray_, _muros de spray_. Never a bare _plafón_ or _muro_ for the spray wall either (_Resetear este plafón_ → _Resetear este Spraywall_). **Plafón stays the word for Kilter, Tension and MoonBoard boards** (section above); only a spray wall is a Spraywall, so a sentence about "your boards" in general keeps _plafones_. Hold-detection copy keeps its own words (_presa_, _bloque_); only the name of the wall changes.

- Store `keywords.txt` keeps the search words people type; everything else in `fastlane/metadata` follows this section.
- `spray-term-consistency.test.ts` in `@boardsesh/i18n` bans the retired names in every Spanish string and store text, and bare _plafón_ / _muro_ in spray-wall strings.

## Other climbing terms

These are already used consistently in the catalogs — keep using them so we don't drift.

| English                 | Spanish                |
| ----------------------- | ---------------------- |
| hold                    | presa                  |
| climb / boulder problem | bloque                 |
| route                   | vía                    |
| send (logged ascent)    | encadene               |
| attempt                 | intento                |
| wall                    | muro                   |
| gym                     | rocódromo              |
| angle                   | ángulo                 |
| grade                   | grado                  |
| session                 | sesión                 |
| queue                   | cola                   |
| climber                 | escalador / escaladora |
| Party Mode              | Modo Fiesta            |
| kickboard (climb rule)  | repisa (inferior)      |
| campus (no feet)        | Campus (kept in English) |

Kept in English by convention (technical board-config terms): **layout**, **set / sets**, **logbook**, **setter**, **beta**.

## Process

- Add every new key to **all** locales (`en-US`, `es`, `fr`, `de`) — `catalog-completeness.test.ts` fails on missing keys.
- See the root `CLAUDE.md` "Internationalisation" section for the rest of the i18n workflow.
