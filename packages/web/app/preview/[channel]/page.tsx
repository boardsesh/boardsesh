import { notFound, redirect } from 'next/navigation';

const PREVIEW_BRANCH_PATTERN = /^pr-([1-9]\d*)$/;
const REPOSITORY_PULLS_URL = 'https://github.com/boardsesh/boardsesh/pull';

type Props = {
  params: Promise<{ channel: string }>;
};

/**
 * Compatibility redirect for links emitted by the retired custom OTA picker.
 * New preview comments point testers at xprem's in-app branch picker, but old
 * comments remain in GitHub history. Keep their HTTPS target useful without
 * restoring the custom channel-selection surface.
 */
export default async function LegacyOtaPreviewPage({ params }: Props) {
  const { channel } = await params;
  const match = PREVIEW_BRANCH_PATTERN.exec(channel);
  if (!match) notFound();

  const pullNumber = Number(match[1]);
  if (!Number.isSafeInteger(pullNumber)) notFound();

  redirect(`${REPOSITORY_PULLS_URL}/${pullNumber}`);
}
