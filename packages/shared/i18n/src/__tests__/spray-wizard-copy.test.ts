import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// #5960: the add-a-wall wizard and the reset flow are prose a climber reads
// mid-task, and the house style keeps em dashes out of it (CLAUDE.md, "Avoid
// AI-writing tells"). A reset string shipped with one; this keeps the two flows
// clean in every locale. The per-hold row labels (`sprayReset.hold.*`) are
// "Hold 12 — coming off" list labels, not prose, and are left out on purpose.

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');
const LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
const EM_DASH = '—';

type Catalog = { [key: string]: string | Catalog };

function strings(node: string | Catalog, path: string): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, child]) => strings(child, `${path}.${key}`));
}

function boards(locale: string): Catalog {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'boards.json'), 'utf8')) as Catalog;
}

describe('spray wizard and reset copy', () => {
  for (const locale of LOCALES) {
    it(`has no em dash in the ${locale} prose`, () => {
      const catalog = boards(locale);
      const reset = catalog.sprayReset as Catalog;
      const prose = [
        ...strings(catalog.sprayWizard, 'sprayWizard'),
        ...Object.entries(reset)
          .filter(([key]) => key !== 'hold')
          .flatMap(([key, child]) => strings(child, `sprayReset.${key}`)),
      ];
      expect(prose.filter(([, text]) => text.includes(EM_DASH)).map(([path]) => path)).toEqual([]);
    });
  }
});
