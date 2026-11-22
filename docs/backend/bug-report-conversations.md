# Bug-report conversations

Signed-in reporters can open **Your bug reports** from the user drawer to see
their reports and reply to Boardsesh. They do not need a GitHub account. The
linked GitHub issue is the discussion: the app displays a filtered cache of its
comments, and the existing Boardsesh Feedback Bot publishes app replies there.
Pending app replies are a durable outbox, not a separate discussion.

## Replying from GitHub

Each new bug-report issue includes a reminder for collaborators. To reply,
start a comment on the report's linked issue with this exact first line:

```text
/reply
Could you try refreshing your board list and tell us what happens?
```

Write the reply on the following lines. The app displays only the reply text.
Existing comments using `#replytocustomer` on its own first line still work.
Only human repository collaborators whose current GitHub permission is
write, maintain, or admin can publish these replies. The backend checks the
comment's current author and repository permission through GitHub; webhook
author-association strings are not an authorization source. Ordinary comments,
pull-request comments, bot comments, and comments from other repositories do not
become customer messages.

The reporter's email-contact setting controls email only. Tagged replies can
reach every signed-in reporter through the app. Anonymous reports have no
account to receive a reply.

## What the reporter sees

The app shows the original report, attached screenshots, and conversation in
time order. A notice immediately above the reply box explains that replies are
public on the GitHub bug tracker, anyone can read them, and no GitHub account is
needed. The action remains **Send reply**. The public tracker link is optional.

The bot posts a generic reporter attribution, with no account name, email, or
internal account ID. Existing sensitive-text redaction applies before posting.
Pending replies say **Waiting to post…**; exhausted delivery attempts expose a
retry action. Retrying a committed request reuses its identifier, and an opaque
comment marker reconciles an ambiguous GitHub response before another comment
is posted.

Edits and deletions on GitHub update or withdraw cached messages, including
bot-posted reporter replies. Removing the staff marker withdraws that message
from the app. The original GitHub timestamps determine the conversation order.
The app refreshes conversations when they open, the app returns to the foreground,
or the socket reconnects. Open conversations do not poll periodically.

Status changes, comment edits and withdrawals, and reply delivery updates also
refresh report history, conversations, and the bell through a dedicated
authenticated subscription. Each event rechecks current report ownership. This
stream works even when a change has no visible notification row; the notification
stream keeps its existing persistence and privacy checks.

Report events refresh only the changed conversation and the visible history/bell.
Events arriving within 200 milliseconds share a refresh; a change arriving during
a request gets a trailing refresh after that request finishes. Hidden history
and notification lists stay stale until reopened. Sending or retrying a reply
uses the mutation's returned message immediately, without reloading history.
Read acknowledgements mark the matching bell group locally. Reading new replies
reconciles only the unread badge count, after older notification reads settle;
this avoids subtracting a read twice from a concurrent response. Own replies and
delivery updates do not acknowledge the thread again.

GitHub does not automatically redeliver failed webhooks. Opening a report also
requests a complete comment reconciliation, throttled to one refresh per report
per 30 seconds. This recovers missed replies, edits, and deletions through the
same contributor checks without scanning every user's reports in the background.

User-facing open/closed status follows the GitHub issue. Existing admin triage
labels remain internal. The admin dashboard can filter a reporter's bugs and
find reports needing a reply, then open the issue to respond.

## Backend setup

1. Keep the existing Feedback Bot installation configured for the repository
   selected by `FEEDBACK_GITHUB_REPO` / `QA_GITHUB_REPO`. It needs Issues write
   and Metadata read access, in addition to its existing permissions.
2. Set `GITHUB_FEEDBACK_WEBHOOK_SECRET` on the backend to a strong random secret.
   Configure the same secret on a GitHub repository or App webhook.
3. Set the webhook URL to
   `https://ws.boardsesh.com/api/github/feedback-webhook` (substitute the backend
   origin for another environment), with JSON payloads and `issue_comment` and
   `issues` events enabled.
4. Before merging, set the repository variable `APP_WEB_DEPLOY_HOLD=1` to hold
   the browser app. Merge after required checks pass. Production Deploy applies
   the generated database migration and initializes the job queues; native OTA
   promotion waits for the backend deployment. The browser deployment runs
   independently, so keep its hold until the new backend is live, then clear the
   variable and dispatch Production Deploy on main to release the browser app.
   Enable the
   webhook after the backend is live. The endpoint returns 404 when its secret
   is absent, rejects invalid HMAC signatures, and acknowledges events after
   durable enqueue.
5. Verify with a dedicated test account and issue before using customer reports.
   Test real-device push separately: automated tests and bundle exports cannot
   establish APNs/FCM delivery or phone keyboard behavior.

The existing Postgres job queue owns inbound synchronization, outbound comments,
and push delivery. Staff messages create a persistent bell notification and push
jobs in the same transaction. Push payloads contain generic copy, not message
text, and delivery rechecks report ownership and the registered device's account,
token, activity, and expiry. Declining push permission still leaves app history
and bell notifications available.

## Acceptance checks

1. Submit a signed-in bug report and find it in Your bug reports.
2. Add an authorized tagged GitHub comment; see its message and reply alert.
3. Send an app reply after reading the public notice; see one bot comment.
4. Edit or delete either comment on GitHub; see the app reconcile it.
5. Try an unauthorized tag and another account's report; neither grants access.
