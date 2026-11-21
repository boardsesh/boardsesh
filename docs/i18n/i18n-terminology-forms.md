# Terminology feedback forms

Use one [Google Apps Script](../../scripts/create-terminology-form.gs) to create
native-speaker terminology questionnaires. Select `TERMINOLOGY_FORM_LOCALE` and
run **`createTerminologyForm`**. The same function creates a draft or resumes
that language's saved progress. The script currently includes the reviewed
Simplified Chinese (`zh-CN`) profile; future languages add their reviewed copy
to the profile registry in this file.

## Create or resume a form

1. Open a standalone project in [Apps Script](https://script.google.com/home/start). For an existing draft, use its original project.
2. Replace `Code.gs` with the complete generator and save. Select the language at the top; `zh-CN` is the default. An obsolete `Repair.gs` from the earlier Chinese setup can be removed after saving the new generator.
3. Select **`createTerminologyForm`** and run it. Approve Forms authorization if requested. If it reports a partial draft, run the same function again.
4. Open the logged edit URL and review the questions. The Chinese profile has 32 optional questions in five sections. Confirm email collection, one-response limits, response summaries, quiz mode, and shuffle are off.
5. Publish with **Anyone with the link**, then check the respondent URL signed out: no login, no email collection, optional answers, and no public response summary. Configure that respondent URL in the app after verification.

The script creates an unpublished draft and never publishes, submits answers,
reads responses, deletes questions, or grants responder/Drive permissions.
Modern responder access and Workspace policies still require the owner's check
in Google's UI. A draft respondent URL alone does not prove public access.

## Reruns and saved progress

Each locale has its own ScriptProperties checkpoint. Switching to another
registered locale creates or resumes its own form. Switching back resumes the
original form. Unsupported locale names fail before creating a form.

Chinese keeps `BOARDSESH_CHINESE_TERMINOLOGY_FORM_V1` and its existing plan
signature, so installing this generator in the original project reuses the
existing draft, completed questions, and pending question IDs. No checkpoint
reset or separate repair script is needed.

The generator manages the choices of an unfinished checkbox with a known saved
item ID. It restores that question's planned choices and disables Google's
separate built-in Other option before continuing. Its ID, type, wording,
optional setting, preceding questions, and unpublished draft must still match.
Completed questions remain untouched. Completed form reruns only report URLs,
preserving owner edits, responses, and publication state.

An unknown append result cannot silently become permission to overwrite an
item. Changed question identities, text, required settings, or unexpected
items stop for owner review. Keep ScriptProperties and the reviewed question
plan intact while a draft is incomplete.

If creation was interrupted before its draft ID was saved, find the empty
unpublished draft in the prior execution log, set
`TERMINOLOGY_RECOVER_DRAFT_ID`, and run the same function. The generator will
not create a second form when the prior creation outcome is uncertain.

## Add a language

Add one entry to `TERMINOLOGY_FORM_PROFILES`, keyed by its locale, with its
translated title, description, confirmation message, and plan builder. Keep
the shared engine unchanged. Each plan defines ordered sections and questions
with stable keys, types, titles, help text, and checkbox choices. The Chinese
plan is the reference for the 28 terminology topics and questionnaire format.

Have a translator review the profile and a separate reviewer check the wording
and behavior before using it. Set `TERMINOLOGY_FORM_LOCALE` to the new key and
run `createTerminologyForm` in the same project. The engine derives a separate
checkpoint key for that locale, leaving every other form's progress intact.

Do not change an in-progress profile's ordered plan to force past a checkpoint
error. Finish or inspect that draft first; a changed plan intentionally stops
instead of duplicating questions.

## Validation limits

Repository tests use a FormApp stand-in and cover Google-provided initial
values, reruns, legacy Chinese progress, locale isolation, uncertain writes,
and owner-edit guards. They do not prove live Google authorization,
publication, or signed-out respondent access.
