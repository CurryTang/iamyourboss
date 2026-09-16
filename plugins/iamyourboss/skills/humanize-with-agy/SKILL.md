---
name: humanize-with-agy
description: Rewrite prose to remove common AI-writing tells while preserving facts, intent, and the author's voice; use Agy as an optional independent editing pass when available.
---

# Humanize with Agy

Preserve the source's facts, technical meaning, audience, and degree of certainty. Remove inflated significance, promotional phrasing, vague attribution, generic transitions, repetitive three-part lists, unnecessary headings, excessive bolding and em dashes, canned chatbot language, and tidy but empty conclusions. Prefer concrete nouns, simple verbs, varied rhythm, and specific evidence.

When the current agent is not Agy and the `agy` CLI is available, use it as a read-only second editor with `agy --print --mode plan`. Give it the source file or exact text, target audience, and desired voice. Do not pass secrets or unrelated workspace context. Do not use auto-approval flags. Review its rewrite yourself: restore any lost facts, citations, intentional terminology, or author-specific quirks.

When already running in Agy, perform the same two-pass edit directly: draft once, identify the remaining obvious AI tells, then revise. Return the finished copy unless the user explicitly asks to see the editorial audit.
