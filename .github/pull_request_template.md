## Summary

<!-- What this change does and why. Link the issue it closes (Closes #123). -->

## Release Notes

<!--
The line(s) below ship to users in the mobile "What's New" screen.

Write in climber voice. Describe what the user gets, not what the feature does:
  - "Resume a session right where you left off"  (good)
  - "Added session-resume state to the queue reducer"  (too internal)

One short line per user-facing change. The first line is the headline; any extra
lines fill in the detail. Keep it to what someone would actually notice.

Nothing user-facing (refactor, CI, deps, tests)? Tick the checkbox below instead
(or add the `skip-changelog` label). Leaving this section blank fails CI.
-->

- [ ] No release note needed (internal / technical change)

## Test plan

<!--
A tester reads this on their phone, in 5 minutes, with ADHD. Testers pick this PR
in the Boardsesh app and see these steps word for word.
  - 1 to 5 numbered steps. One action, then what they should see. 12 words or fewer.
  - Name the screen: "You tab → Log a tick → note field grows to 8 lines".
  - Needs a board, Bluetooth, or a signed-in account? Say so in step 1.
  - Write what a tester taps and sees, NOT what you ran. No commands, no repo
    paths, no CI log steps — the gate rejects them. Author-side verification is
    worth keeping: put it in the Summary, where reviewers read it.
  - Internal-only change (CI, deps, refactor)? "1. CI green." is the whole plan.
Leaving this empty fails CI (`pr-test-plan`). Maintainers can add `skip-qa-gate`.
-->

1.

## Risk

<!--
One line: `Risk: N/5 — why`. Testers see the score next to the PR.
  1  docs, CI, deps, copy
  2  isolated UI or logic with tests
  3  new screen, shared package, backend resolver
  4  data writes, offline sync, auth-adjacent, publish pipeline
  5  BLE, OTA/native config, migrations with backfill (BLE also needs a Fable review)
-->

Risk: /5 —
