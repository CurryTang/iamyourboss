---
name: experiment-table
description: Create a compact, self-contained HTML table for experiment comparisons, ablations, baselines, or guardrails that will be attached to an iamyourboss report.
---

# Experiment table

Create one `.html` artifact in the current workspace and return its path. It must work offline and be safe to render in a sandboxed iframe:

- use semantic `<table>`, `<caption>`, headings, and inline CSS;
- include metric units, directionality, sample or seed count, and uncertainty when available;
- use consistent precision and an em dash for missing values;
- identify the baseline and highlight winners only when the comparison justifies it;
- keep raw rows available in the table rather than hiding inconvenient results;
- add one short takeaway above the table and any essential caveat below it;
- use no external fonts, scripts, images, CDNs, or network requests.

Prefer a table over a figure when exact values or several repeated-field comparisons are the main evidence. Attach the HTML through `$advisor-report`; do not treat creating the artifact itself as a report-worthy event.
