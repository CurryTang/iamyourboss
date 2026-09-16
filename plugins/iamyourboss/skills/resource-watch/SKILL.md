---
name: resource-watch
description: Bind local or SSH experiment process trees to a supervised iamyourboss session so the advisor can see scoped CPU, RAM, and GPU usage in real time.
---

# Resource watch

Use only after the host hook activates advisor mode for this session. The MCP server automatically uses the coding-agent process tree for local sampling; set `resourceRootPid` only when the supervised workload has a different, known local root. For each remote workload the session actually launched or owns, add one `remoteResources` entry with:

- the exact non-interactive SSH target;
- the root PID whose descendants belong to this session;
- a concise host label.

Never bind a whole host, another user's process, a scheduler-wide process, or a PID inferred only from a name match. If the root PID changes, start a new goal registration only when the work itself is a new goal; otherwise report the changed binding limitation rather than inventing continuity.

The dashboard samples selected process trees every 30 seconds and reports CPU, RAM, GPU memory, peaks, and core-hours. Resource sampling is context, not an advisor report by itself; report only when the resource result changes a conclusion or requires a decision.
