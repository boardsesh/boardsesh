'use client';

import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, Prose } from '@/app/components/ui/page-shell';
import { JsonLd } from '@/app/lib/seo/json-ld';

const QUESTION_IDS = [
  'operator',
  'funding',
  'compatibility',
  'import',
  'password',
  'shutdown',
  'tracking',
  'sprayPrivacy',
] as const;
const ACCORDION_SX = {
  bgcolor: 'background.paper',
  color: 'text.primary',
  border: 1,
  borderColor: 'divider',
  '&:before': { display: 'none' },
} as const;
const SUMMARY_SX = { minHeight: 44, '& .MuiAccordionSummary-content': { minWidth: 0 } } as const;

/** The visible answers and structured data always come from the same selection. */
export default function TrustFaq({ limit = 8 }: { limit?: 6 | 8 }) {
  const { t } = useTranslation('marketing');
  const questions = QUESTION_IDS.slice(0, limit).map((questionId) => ({
    id: questionId,
    question: t(`trust.questions.${questionId}.question`),
    answer: questionId === 'funding' ? t('funding.body') : t(`trust.questions.${questionId}.answer`),
  }));

  return (
    <PageSection title={t('trust.title')} id="trust-questions" tone="neutral">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: questions.map(({ question, answer }) => ({
            '@type': 'Question',
            name: question,
            acceptedAnswer: { '@type': 'Answer', text: answer },
          })),
        }}
      />
      {questions.map(({ id, question, answer }) => (
        <Accordion key={id} disableGutters elevation={0} sx={ACCORDION_SX} slotProps={{ heading: { component: 'h3' } }}>
          <AccordionSummary
            id={`trust-${id}-question`}
            aria-controls={`trust-${id}-answer`}
            expandIcon={<ExpandMoreOutlined />}
            sx={SUMMARY_SX}
          >
            <Typography component="span">{question}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Prose>{answer}</Prose>
          </AccordionDetails>
        </Accordion>
      ))}
      <Prose>
        <MuiLink component={LocaleLink} href="/legal">
          {t('trust.legal')}
        </MuiLink>
        {' · '}
        <MuiLink component={LocaleLink} href="/bring-your-logbook">
          {t('trust.import')}
        </MuiLink>
        {' · '}
        <MuiLink component={LocaleLink} href="/privacy">
          {t('trust.privacy')}
        </MuiLink>
      </Prose>
    </PageSection>
  );
}
