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

## Other climbing terms

These are already used consistently in the catalogs — keep using them so we don't drift.

| English                 | Spanish                            |
| ----------------------- | ---------------------------------- |
| hold                    | presa                              |
| climb / boulder problem | bloque                             |
| route                   | vía                                |
| send (logged ascent)    | encadene                           |
| attempt                 | intento                            |
| wall                    | muro                               |
| gym                     | gimnasio (climbing gym: rocódromo) |
| angle                   | ángulo                             |
| grade                   | grado                              |
| session                 | sesión                             |
| queue                   | cola                               |
| climber                 | escalador / escaladora             |
| Party Mode              | Modo Fiesta                        |

Kept in English by convention (technical board-config terms): **layout**, **set / sets**, **logbook**, **setter**, **beta**.

**`playlist` / `playlists`** also stay in English — used throughout `es/playlists.json` (_Compartir playlist_, _¿Iniciar playlist?_, _Playlist eliminada_). Feminine: _la playlist_, _esta playlist_, _las playlists_. Never _lista de reproducción_.

## Process

- Add every new key to **all** locales (`en-US`, `es`, `fr`) — `catalog-completeness.test.ts` fails on missing keys.
- See the root `CLAUDE.md` "Internationalisation" section for the rest of the i18n workflow.
