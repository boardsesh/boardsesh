import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { useShareIntent } from 'expo-share-intent';
import { FEEDBACK_ATTACHMENT_MAX_COUNT, isBetaVideoUrl } from '@boardsesh/shared-schema';
import { extractSharedLink } from '../lib/shared-link';
import { reportHandledError } from '../lib/error-reporting';
import {
  loadSharedBugDraft,
  saveSharedBugDraft,
  removeSharedBugDraft,
  prepareSharedAttachment,
  releaseOwnedFeedbackAttachments,
  releaseNativeShareCopies,
  pruneSharedBugFiles,
  PENDING_SHARE_LINK_KEY,
  SharedAttachmentError,
} from '../lib/feedback/shared-bug-draft';
import type {
  FeedbackAttachment,
  SharedBugDraft,
  SharedBugDraftUpdates,
  ShareReceiptNotice,
} from '../lib/feedback/shared-bug-draft.types';
import { ShareReceiptStateContext, ShareReceiptActionsContext } from './share-receipt-context';

export { useSharedBugDraft, useShareReceipt } from './share-receipt-context';

/** Owns the native payload above auth/loading redirects. Navigation lives below them. */
export function ShareReceiptProvider({ children }: { children: ReactNode }) {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({ resetOnBackground: false });
  const [draft, setDraft] = useState<SharedBugDraft | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<ShareReceiptNotice | null>(null);
  const [revision, setRevision] = useState(0);
  const [destination, setDestination] = useState<'bug' | 'beta' | null>(null);
  const draftRef = useRef<SharedBugDraft | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const processedSignatures = useRef(new Set<string>());
  const receivingSignatures = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const resetRef = useRef(resetShareIntent);
  resetRef.current = resetShareIntent;
  const signature = hasShareIntent ? JSON.stringify(shareIntent) : '';
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  const publishDraft = useCallback((nextDraft: SharedBugDraft | null) => {
    draftRef.current = nextDraft;
    if (mountedRef.current) setDraft(nextDraft);
  }, []);

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const pending = queueRef.current.then(operation);
    // A failed write must not poison later receives or form updates.
    queueRef.current = pending.catch(() => {});
    return pending;
  }, []);

  const resetNativeReceipt = useCallback(() => {
    try {
      resetRef.current();
    } catch (caught) {
      // The draft has committed already; a reset failure must never remove it.
      reportHandledError(caught, { tags: { source: 'share-receipt', op: 'reset' } });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void enqueue(async () => {
      const [storedDraft, storedLink] = await Promise.all([
        loadSharedBugDraft(),
        AsyncStorage.getItem(PENDING_SHARE_LINK_KEY),
      ]);
      publishDraft(storedDraft);
      pruneSharedBugFiles(storedDraft);
      if (mountedRef.current && storedLink && isBetaVideoUrl(storedLink)) setPendingLink(storedLink);
      if (mountedRef.current)
        setDestination(storedLink && isBetaVideoUrl(storedLink) ? 'beta' : storedDraft ? 'bug' : null);
    }).catch((caught: unknown) => {
      if (mountedRef.current) setNotice('failed');
      reportHandledError(caught, { tags: { source: 'share-receipt', op: 'restore' } });
    });
    return () => {
      mountedRef.current = false;
    };
  }, [enqueue, publishDraft]);

  const updateDraft = useCallback(
    (draftId: string, updates: SharedBugDraftUpdates) =>
      enqueue(async () => {
        const current = draftRef.current;
        if (!current || current.id !== draftId) return;
        const { attachmentBaselineIds, ...changes } = updates;
        const next = { ...current, ...changes, id: current.id };
        if (changes.attachments && attachmentBaselineIds) {
          const baselineIds = new Set(attachmentBaselineIds);
          const editedIds = new Set(changes.attachments.map((attachment) => attachment.id));
          const unseenReceipts = current.attachments.filter(
            (attachment) => !baselineIds.has(attachment.id) && !editedIds.has(attachment.id),
          );
          next.attachments = [
            ...changes.attachments.filter((attachment) => baselineIds.has(attachment.id)),
            ...unseenReceipts,
            ...changes.attachments.filter((attachment) => !baselineIds.has(attachment.id)),
          ];
        }
        if (next.attachments.length > FEEDBACK_ATTACHMENT_MAX_COUNT && mountedRef.current) setNotice('overflow');
        next.attachments = next.attachments.slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT);
        await saveSharedBugDraft(next);
        publishDraft(next);
        const keptUris = new Set(next.attachments.map((attachment) => attachment.uri));
        releaseOwnedFeedbackAttachments(
          [...current.attachments, ...(changes.attachments ?? [])].filter(
            (attachment) => !keptUris.has(attachment.uri),
          ),
        );
      }),
    [enqueue, publishDraft],
  );

  const clearDraft = useCallback(
    (draftId: string) =>
      enqueue(async () => {
        const current = draftRef.current;
        if (!current || current.id !== draftId) return;
        await removeSharedBugDraft();
        publishDraft(null);
        if (mountedRef.current) setDestination((current) => (current === 'bug' ? null : current));
        releaseOwnedFeedbackAttachments(current.attachments);
      }),
    [enqueue, publishDraft],
  );

  const finishDraftSubmission = useCallback(
    async (draftId: string, submittedAttachmentIds: readonly string[]): Promise<boolean> => {
      let cleared = false;
      await enqueue(async () => {
        const current = draftRef.current;
        if (!current || current.id !== draftId) {
          cleared = true;
          return;
        }
        const submittedIds = new Set(submittedAttachmentIds);
        const remaining = current.attachments.filter((attachment) => !submittedIds.has(attachment.id));
        if (remaining.length === 0) {
          await removeSharedBugDraft();
          publishDraft(null);
          if (mountedRef.current) setDestination((pending) => (pending === 'bug' ? null : pending));
          cleared = true;
        } else {
          const next = { ...current, attachments: remaining, comment: '', contactConsent: true, uploadedKeysByUri: {} };
          await saveSharedBugDraft(next);
          publishDraft(next);
        }
        releaseOwnedFeedbackAttachments(current.attachments.filter((attachment) => submittedIds.has(attachment.id)));
      });
      return cleared;
    },
    [enqueue, publishDraft],
  );

  const consumeLink = useCallback(
    (link: string) =>
      enqueue(async () => {
        const storedLink = await AsyncStorage.getItem(PENDING_SHARE_LINK_KEY);
        if (storedLink !== link) return;
        await AsyncStorage.removeItem(PENDING_SHARE_LINK_KEY);
        if (mountedRef.current) setPendingLink((current) => (current === link ? null : current));
        if (mountedRef.current) setDestination((current) => (current === 'beta' ? null : current));
      }),
    [enqueue],
  );
  const clearNotice = useCallback(() => setNotice(null), []);
  const consumeBugNavigation = useCallback(() => setDestination((current) => (current === 'bug' ? null : current)), []);

  useEffect(() => {
    if (!hasShareIntent || !signature || receivingSignatures.current.has(signature)) return;
    if (processedSignatures.current.has(signature)) {
      resetNativeReceipt();
      return;
    }
    const received = shareIntent;
    receivingSignatures.current.add(signature);
    void enqueue(async () => {
      const prepared: FeedbackAttachment[] = [];
      let receiveNotice: ShareReceiptNotice | null = null;
      let draftCommitted = false;
      try {
        if (received.files?.length) {
          const current = draftRef.current;
          const remaining = FEEDBACK_ATTACHMENT_MAX_COUNT - (current?.attachments.length ?? 0);
          if (received.files.length > remaining) receiveNotice = 'overflow';
          for (const file of received.files) {
            if (prepared.length >= remaining) break;
            if (file.mimeType === 'application/x-boardsesh-share-overflow') {
              receiveNotice = 'overflow';
              continue;
            }
            try {
              prepared.push(await prepareSharedAttachment(file));
            } catch (caught) {
              if (caught instanceof SharedAttachmentError && caught.reason !== 'failed') {
                receiveNotice = caught.reason;
                continue;
              }
              throw caught;
            }
          }
          if (prepared.length > 0) {
            const next: SharedBugDraft = current
              ? { ...current, attachments: [...current.attachments, ...prepared] }
              : { id: randomUUID(), attachments: prepared, comment: '', contactConsent: true, uploadedKeysByUri: {} };
            await saveSharedBugDraft(next);
            draftCommitted = true;
            publishDraft(next);
          }
          if (mountedRef.current && draftRef.current) setDestination('bug');
        } else {
          const link = extractSharedLink(received);
          if (link && isBetaVideoUrl(link)) {
            await AsyncStorage.setItem(PENDING_SHARE_LINK_KEY, link);
            if (mountedRef.current) setPendingLink(link);
            if (mountedRef.current) setDestination('beta');
          } else if (link) receiveNotice = 'invalidLink';
        }
        if (processedSignatures.current.size >= 32) processedSignatures.current.clear();
        processedSignatures.current.add(signature);
        if (mountedRef.current) {
          setNotice(receiveNotice);
          setRevision((current) => current + 1);
        }
        // Do not clear a newer native payload while an older copy is finishing.
        if (signatureRef.current === signature) resetNativeReceipt();
        if (received.files) {
          try {
            releaseNativeShareCopies(received.files);
          } catch (caught) {
            reportHandledError(caught, { tags: { source: 'share-receipt', op: 'clean-native-copies' } });
          }
        }
      } catch (caught) {
        if (!draftCommitted) releaseOwnedFeedbackAttachments(prepared);
        if (mountedRef.current) setNotice('failed');
        reportHandledError(caught, { tags: { source: 'share-receipt', op: 'receive' } });
        // Keep the native intent intact so a copy/persistence failure can retry.
      } finally {
        receivingSignatures.current.delete(signature);
      }
    });
  }, [hasShareIntent, shareIntent, signature, enqueue, publishDraft, resetNativeReceipt]);

  useEffect(() => {
    if (error) setNotice('failed');
  }, [error]);
  const state = useMemo(
    () => ({ draft, pendingLink, notice, revision, destination }),
    [draft, pendingLink, notice, revision, destination],
  );
  const actions = useMemo(
    () => ({ updateDraft, clearDraft, finishDraftSubmission, consumeLink, clearNotice, consumeBugNavigation }),
    [updateDraft, clearDraft, finishDraftSubmission, consumeLink, clearNotice, consumeBugNavigation],
  );
  return (
    <ShareReceiptActionsContext.Provider value={actions}>
      <ShareReceiptStateContext.Provider value={state}>{children}</ShareReceiptStateContext.Provider>
    </ShareReceiptActionsContext.Provider>
  );
}
