import type { TFunction } from 'i18next';
import { PUBLIC_API_CHANGELOG } from '@boardsesh/public-api';
import { AUTHORIZE_SAMPLE, TOKEN_SAMPLE, SYNC_SAMPLE, OPENAPI_URL } from './developers-docs-samples';

export const GUIDE_SECTIONS = {
  auth: ['registration', 'authorize', 'credentials', 'disconnect'],
  sync: ['snapshot', 'changes', 'sessions', 'recovery', 'poll', 'attribution'],
  errors: ['status', 'limits', 'versions'],
  reference: ['contract'],
  changelog: ['contract'],
} as const;
export type GuideSlug = keyof typeof GUIDE_SECTIONS;
export const GUIDE_SLUGS = Object.keys(GUIDE_SECTIONS) as GuideSlug[];
export const EXAMPLE_URL = 'https://raw.githubusercontent.com/boardsesh/boardsesh/main/examples/logbook-sync.ts';
export const MOCK_COMMAND = `# Prism requires Node 24.18 or newer.\nvp dlx @stoplight/prism-cli@5.16.0 mock ${OPENAPI_URL}`;
export const EXAMPLE_COMMAND = 'node logbook-sync.ts connect --client-id YOUR_CLIENT_ID --file /private/boardsesh.json';

export function guideCode(slug: GuideSlug, section: string): string | undefined {
  if (slug === 'auth' && section === 'authorize') return `${AUTHORIZE_SAMPLE}\n\n${TOKEN_SAMPLE}`;
  if (slug === 'sync' && section === 'snapshot') return SYNC_SAMPLE;
  if (slug === 'sync' && section === 'recovery') return EXAMPLE_COMMAND;
  if (slug === 'reference') return MOCK_COMMAND;
  return undefined;
}

export function guideDocument(slug: GuideSlug, t: TFunction): string {
  const parts = [`# ${t(`guides.${slug}.title`)}`, t(`guides.${slug}.description`)];
  for (const section of GUIDE_SECTIONS[slug]) {
    parts.push(`## ${t(`guides.${slug}.${section}.title`)}`, t(`guides.${slug}.${section}.body`));
    const code = guideCode(slug, section);
    if (code) parts.push(`\`\`\`sh\n${code}\n\`\`\``);
  }
  if (slug === 'changelog') {
    for (const entry of PUBLIC_API_CHANGELOG)
      parts.push(`## ${entry.date}`, ...entry.changes.map((change) => `- ${change}`));
  }
  parts.push(
    `[${t('guides.labels.openapi')}](${OPENAPI_URL})`,
    `[${t('guides.labels.example')}](${EXAMPLE_URL})`,
    ...GUIDE_SLUGS.filter((other) => other !== slug).map(
      (other) => `[${t(`guides.${other}.title`)}](https://www.boardsesh.com/developers/${other}.md)`,
    ),
    `[${t('guides.labels.home')}](https://www.boardsesh.com/developers)`,
  );
  return `${parts.join('\n\n')}\n`;
}
