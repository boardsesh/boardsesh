'use client';

import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, Prose } from '@/app/components/ui/page-shell';
import { JsonLd } from '@/app/lib/seo/json-ld';
import type { TrustFaqCopy } from './trust-faq-copy';

const ACCORDION_SX = {
  bgcolor: 'background.paper',
  color: 'text.primary',
  border: 1,
  borderColor: 'divider',
  '&:before': { display: 'none' },
} as const;
const SUMMARY_SX = { minHeight: 44, '& .MuiAccordionSummary-content': { minWidth: 0 } } as const;

/** The visible answers and structured data always come from the same selection. */
export default function TrustFaqContent({ copy }: { copy: TrustFaqCopy }) {
  const { questions } = copy;

  return (
    <PageSection title={copy.title} id="trust-questions" tone="neutral">
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
          {copy.legal}
        </MuiLink>
        {' · '}
        <MuiLink component={LocaleLink} href="/bring-your-logbook">
          {copy.import}
        </MuiLink>
        {' · '}
        <MuiLink component={LocaleLink} href="/privacy">
          {copy.privacy}
        </MuiLink>
      </Prose>
    </PageSection>
  );
}
