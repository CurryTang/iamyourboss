---
name: advisor-report
description: Synthesize an important result, consequential decision request, or completed goal into an iamyourboss advisor report. Use only in a session where advisor mode has been activated.
---

# Advisor report

Use the iamyourboss MCP tools only when the host hook says this session is supervised.

Report a conclusion, not activity. Choose exactly one:

- `report` for an important finding that does not require a response;
- `request` when consequential human judgment is required;
- `finish` when the assigned goal or requested stopping point is complete.

Lead with one sentence that changes the advisor's understanding. Add only the strongest evidence, a short interpretation, and a concrete next step or ask. Do not include terminal output, tool history, routine edits, or implementation narration.

When a comparison is central, use `$experiment-table`. When shape, trend, uncertainty, or interaction is central, use `$experiment-figure`. Attach the resulting HTML file to the report instead of copying a large data dump into prose. Submit one report for one advisor-worthy conclusion.

When the advisor explicitly requests a current-state report, use `$progress-brief` and attach its HTML artifact even if the goal is incomplete.
