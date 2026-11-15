import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { formatSessionWhen } from '../../lib/format-session-when';
import { getSoleBoardType } from '../../lib/grade-label';
import { AvatarGroup } from '../you/AvatarGroup';
import { FeedSocialRow } from '../you/FeedSocialRow';
import { SessionSummaryCardView } from './SessionSummaryCardView';
export { SessionNotesCard } from './SessionSummaryCardView';
type SessionSummaryCardProps = {
  session: SessionDetail;
  /** Pre-resolved display name (session name or a generated date fallback). */
  title: string;
  /** True when the title IS the date (unnamed session) — line 2 then shows a
   *  human "Sunday morning" instead of repeating the date. */
  titleIsDate: boolean;
  /** Absent for a daily group, which has no session row to like or comment on. */
  onOpenComments?: (entityId: string) => void;
  voteSummary?: { upvotes: number; userVote: number | null };
  /** Owner-only: open the edit sheet (name + recap). Absent for non-owners. */
  onEditSession?: () => void;
};

export function SessionSummaryCard({
  session,
  title,
  titleIsDate,
  onOpenComments,
  voteSummary,
  onEditSession,
}: SessionSummaryCardProps) {
  const { t } = useTranslation('session');
  const { formatGrade } = useGradeFormat();
  return (
    <SessionSummaryCardView
      session={session}
      title={title}
      onEditSession={onEditSession}
      whenLine={
        titleIsDate
          ? formatSessionWhen(session.lastTickAt, t)
          : formatTickAbsoluteTime(session.lastTickAt, 'MMM D, YYYY · h:mm A')
      }
      displayHardestGrade={formatGrade(session.hardestGrade, getSoleBoardType(session.boardTypes))}
      avatars={<AvatarGroup participants={session.participants} size={32} />}
      social={
        onOpenComments ? (
          <FeedSocialRow
            entityId={session.sessionId}
            upvotes={voteSummary?.upvotes ?? session.upvotes}
            userVote={voteSummary?.userVote ?? null}
            commentCount={session.commentCount}
            onOpenComments={onOpenComments}
          />
        ) : undefined
      }
    />
  );
}
