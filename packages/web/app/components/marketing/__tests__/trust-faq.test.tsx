import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import TrustFaq from '../trust-faq';

vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('trust FAQ structured data', () => {
  it.each([6, 8] as const)('describes exactly the %i visible questions and their answers', (limit) => {
    const { container } = render(<TrustFaq limit={limit} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    if (!script?.textContent) throw new Error('Expected FAQ structured data');
    const structured = JSON.parse(script.textContent) as {
      '@type': string;
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    expect(structured['@type']).toBe('FAQPage');
    expect(structured.mainEntity).toHaveLength(limit);
    expect(screen.getAllByRole('button')).toHaveLength(limit);
    for (const question of structured.mainEntity) {
      expect(screen.getByRole('button', { name: question.name })).toBeTruthy();
      expect(container.textContent).toContain(question.acceptedAnswer.text);
    }
    expect(structured.mainEntity[1].acceptedAnswer.text).toBe(tFromCatalog('marketing', 'funding.body'));
  });
});
