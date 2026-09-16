#!/usr/bin/env node
import { getConfig } from './config.mjs';
import { api } from './http-client.mjs';
import { CORE_INSTRUCTIONS } from './advisor-instructions.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}

const agentArg = process.argv.indexOf('--agent');
const formatArg = process.argv.indexOf('--format');
const eventArg = process.argv.indexOf('--event');
const agent = agentArg >= 0 ? process.argv[agentArg + 1] : (process.env.IYB_AGENT || (process.env.CODEX_THREAD_ID ? 'Codex' : 'Claude Code'));
const format = formatArg >= 0 ? process.argv[formatArg + 1] : 'claude';
const event = input.hook_event_name || input.hookEventName || (eventArg >= 0 ? process.argv[eventArg + 1] : '');
const sessionKey = input.session_id || input.sessionId || input.conversation_id || input.conversationId || input.thread_id || process.env.CLAUDE_SESSION_ID || process.env.CODEX_THREAD_ID;
const parentSessionKey = input.parent_session_id || input.parentSessionId || input.parent_conversation_id || input.parentConversationId || process.env.IYB_PARENT_SESSION_ID || null;
const isSubagent = Boolean(parentSessionKey || input.is_subagent || input.isSubagent || String(input.agent_type || input.agentType || '').toLowerCase() === 'subagent');
const parts = [];
let supervised = false;
if (sessionKey) {
  try {
    const identified = await api(getConfig().baseUrl, '/api/sessions/identify', { method: 'POST', body: {
      provider: agent, sessionKey, role: isSubagent ? 'SUBAGENT' : 'MAIN', parentSessionKey,
      pid: process.ppid,
      workingDirectory: input.cwd || input.working_directory || process.cwd(),
      terminalTransport: process.env.ZELLIJ_SESSION_NAME ? 'zellij' : process.env.TMUX_PANE ? 'tmux' : null,
      terminalSession: process.env.ZELLIJ_SESSION_NAME || null,
      terminalPane: process.env.ZELLIJ_PANE_ID || process.env.TMUX_PANE || null,
    } });
    supervised = Boolean(identified.supervised);
    if (supervised) {
      parts.push(CORE_INSTRUCTIONS);
      parts.push(`This provider conversation ID is ${sessionKey}. When calling start_goal, pass sessionKey and resumeId exactly as ${sessionKey}, agent as ${agent}, promptTransport as ${format === 'cursor' ? 'cursor' : format === 'agy' ? 'agy' : agent.toLowerCase().includes('codex') ? 'codex' : 'claude'}, and role as ${isSubagent ? 'SUBAGENT' : 'MAIN'}${parentSessionKey ? ` with parentSessionKey ${parentSessionKey}` : ''}.`);
    }
    const inbox = await api(getConfig().baseUrl, `/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionKey)}/inbox`);
    if (supervised && inbox.directives.length) parts.push(`Advisor messages:\n\n${inbox.directives.map((d) => `[${d.kind}] ${d.body}`).join('\n\n')}`);
  } catch { /* Server may not be running yet; never block the coding session. */ }
}
if (parts.length) {
  const context = parts.join('\n\n');
  if (format === 'agy') process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] }));
  else if (format === 'cursor') process.stdout.write(JSON.stringify({ additional_context: context, env: sessionKey ? { IYB_AGENT: agent, IYB_SESSION_ID: sessionKey, IYB_AGENT_ROLE: isSubagent ? 'SUBAGENT' : 'MAIN', ...(parentSessionKey ? { IYB_PARENT_SESSION_ID: parentSessionKey } : {}) } : {} }));
  else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}
