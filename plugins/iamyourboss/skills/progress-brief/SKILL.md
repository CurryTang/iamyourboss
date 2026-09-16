---
name: progress-brief
description: Create the self-contained HTML progress artifact required when an iamyourboss advisor explicitly requests a current-state report.
---

# Progress brief

Use this skill only after an advisor report request. Reach a sensible stopping point, then create one offline `.html` artifact in the current workspace and attach it through `$advisor-report`.

Make the artifact read like a compact lab-meeting slide:

- one-sentence bottom line;
- strongest evidence currently available;
- interpretation, uncertainty, or blocker;
- next step or decision needed.

Include one compact Progress / TODO table with these columns: Item, State (`done`, `running`, `pending`, or `blocked`), Evidence or result, and Next action. Keep finished work and remaining work in the same view so the advisor can understand the session without opening its terminal.

Choose `$experiment-table` or `$experiment-figure` when comparative or quantitative evidence warrants it. Otherwise create a restrained semantic HTML brief with inline CSS. Include useful links to workspace artifacts only when they will remain meaningful to the advisor.

Do not include terminal logs, command output, tool-call history, transcripts, token usage, file-by-file edit narration, or a chronological activity dump. The artifact is a synthesized research record, not session observability.

Submit through `$advisor-report`. If the current session predates the iamyourboss MCP connection, use the narrow CLI fallback shown in the advisor directive: `iyb submit-report --goal <id> --headline <text> --bottom-line <text> --artifact <path>`, with optional `--interpretation`, `--next-step`, or `--type FINAL`. Do not print the artifact into the terminal as a substitute for submission.
