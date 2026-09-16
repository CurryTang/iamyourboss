import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySessions, parseProcessRows } from '../src/session-detector.mjs';

test('session discovery ignores infrastructure and distinguishes main agents from nested subagents', () => {
  const rows = parseProcessRows(`
100 1 ttys001 01:00:00 claude
110 100 ttys001 00:20:00 codex exec review
120 100 ttys001 00:10:00 codex mcp-server
200 1 ttys002 02:00:00 /Users/me/.local/bin/agent /Users/me/cursor-agent/index.js
300 1 ttys003 00:30:00 agy --conversation=agy-123
400 1 ?? 00:12:00 codex app-server
`);
  const environments = {
    100: { CLAUDE_SESSION_ID: 'claude-main' },
    110: { CODEX_THREAD_ID: 'codex-child' },
    200: { CURSOR_SESSION_ID: 'cursor-main', ZELLIJ_SESSION_NAME: 'lab', ZELLIJ_PANE_ID: '4' },
  };
  const sessions = classifySessions(rows, { envForPid: (pid) => environments[pid], cwdForPid: (pid) => `/repo/${pid}`, providerSessionForPid: (pid) => pid === 100 ? { sessionId: 'claude-from-cli', status: 'busy', name: 'demo' } : null, host: 'workstation', now: Date.parse('2026-09-15T12:00:00Z') });
  assert.equal(sessions.length, 4);
  assert.equal(sessions.find((item) => item.session_key === 'claude-from-cli').role, 'MAIN');
  assert.equal(sessions.find((item) => item.session_key === 'claude-from-cli').provider_status, 'busy');
  assert.equal(sessions.find((item) => item.session_key === 'codex-child').role, 'SUBAGENT');
  assert.equal(sessions.find((item) => item.session_key === 'codex-child').parent_session_key, 'claude-from-cli');
  assert.equal(sessions.find((item) => item.session_key === 'cursor-main').terminal_session, 'lab');
  assert.equal(sessions.find((item) => item.provider === 'Agy').session_key, 'agy-123');
});
