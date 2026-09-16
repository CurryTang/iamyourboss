#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { api } from './http-client.mjs';
import { getConfig } from './config.mjs';
import { startResourceSampler } from './resources.mjs';

const config = getConfig();
let agentIdentity = process.env.IYB_AGENT || (process.env.CLAUDE_CODE_ENTRYPOINT ? 'Claude Code' : process.env.CODEX_THREAD_ID ? 'Codex' : 'Coding agent');
let sessionIdentity = process.env.IYB_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || process.env.CURSOR_CHAT_ID || process.env.AGY_CONVERSATION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || randomUUID();
let activeGoalId = process.env.IYB_GOAL_ID || null;
let stopSampler = null;

const tools = [
  {
    name: 'start_goal',
    description: 'Register the current substantive assignment with the advisor. Call once near the start, not for small conversational questions.',
    inputSchema: { type: 'object', required: ['title', 'originalGoal'], properties: {
      title: { type: 'string', description: 'Short goal title' },
      originalGoal: { type: 'string', description: 'The full assignment, summarized faithfully' },
      agent: { type: 'string', description: 'Agent identity, e.g. Codex or Claude Code' },
      sessionKey: { type: 'string', description: 'Host session ID when known' },
      resumeId: { type: 'string', description: 'Provider conversation ID used to resume this exact coding-agent session' },
      promptTransport: { type: 'string', enum: ['claude','codex','agy','cursor'], description: 'Provider transport for advisor-initiated prompts' },
      role: { type: 'string', enum: ['MAIN','SUBAGENT'], description: 'Use SUBAGENT only when the host identifies a parent agent session' },
      parentSessionKey: { type: 'string', description: 'Provider session ID of the parent agent when this is a subagent' },
      repository: { type: 'string' }, workingDirectory: { type: 'string' },
      resourceRootPid: { type: 'integer', description: 'Optional local agent root PID' },
      remoteResources: { type: 'array', description: 'Optional SSH process trees explicitly used by this session', items: { type: 'object', required: ['target','pid'], properties: { target: { type: 'string', description: 'user@host SSH target' }, pid: { type: 'integer' }, label: { type: 'string' } } } },
    } },
  },
  {
    name: 'report',
    description: 'Submit a rare, important advisor update. Report conclusions, not activity. No response is required.',
    inputSchema: reportSchema(false),
  },
  {
    name: 'request',
    description: 'Ask the advisor for a consequential decision. Use blocking only when useful work truly cannot continue.',
    inputSchema: { ...reportSchema(false), required: ['headline','bottomLine','question'], properties: {
      ...reportSchema(false).properties,
      question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } }, recommendedChoice: { type: 'string' }, blocking: { type: 'boolean', default: true },
    } },
  },
  {
    name: 'finish',
    description: 'Submit the final synthesis and mark the goal done.',
    inputSchema: reportSchema(false),
  },
  {
    name: 'check_advisor',
    description: 'Receive pending advisor directives, decisions, and report requests for this session. Call at the start of each turn and sensible stopping points.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function reportSchema(requireGoal = false) {
  return { type: 'object', required: ['headline', 'bottomLine', ...(requireGoal ? ['goalId'] : [])], properties: {
    goalId: { type: 'string' }, meetingId: { type: 'string', description: 'Lab meeting identifier supplied by an advisor meeting request' }, headline: { type: 'string' }, bottomLine: { type: 'string' },
    evidence: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } },
    interpretation: { type: 'string' }, nextStep: { type: 'string' },
    attachments: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, name: { type: 'string' }, mimeType: { type: 'string' } } } },
  } };
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError };
}

async function encodeAttachments(items = []) {
  return Promise.all(items.map(async (item) => ({
    name: item.name || basename(item.path), mimeType: item.mimeType,
    dataBase64: (await readFile(item.path)).toString('base64'),
  })));
}

function inferRepository(cwd) {
  try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return cwd; }
}

function terminalMetadata() {
  if (process.env.ZELLIJ_SESSION_NAME && process.env.ZELLIJ_PANE_ID != null) return {
    terminalTransport: 'zellij', terminalSession: process.env.ZELLIJ_SESSION_NAME, terminalPane: process.env.ZELLIJ_PANE_ID,
  };
  if (process.env.TMUX_PANE) return {
    terminalTransport: 'tmux', terminalSession: process.env.TMUX || null, terminalPane: process.env.TMUX_PANE,
  };
  return {};
}

async function ensureGoal() {
  if (!activeGoalId) throw new Error('No active goal. Call start_goal first.');
  return activeGoalId;
}

async function callTool(name, args = {}) {
  if (name === 'start_goal') {
    const cwd = args.workingDirectory || process.cwd();
    const agent = args.agent || agentIdentity;
    const key = args.sessionKey || sessionIdentity;
    const goal = await api(config.baseUrl, '/api/goals', { method: 'POST', body: { ...terminalMetadata(), ...args, agent, sessionKey: key, resumeId: args.resumeId || key, role: args.role || process.env.IYB_AGENT_ROLE || 'MAIN', parentSessionKey: args.parentSessionKey || process.env.IYB_PARENT_SESSION_ID || null, workingDirectory: cwd, repository: args.repository || inferRepository(cwd) } });
    activeGoalId = goal.id; agentIdentity = agent; sessionIdentity = key;
    stopSampler?.();
    stopSampler = startResourceSampler({ goalId: goal.id, rootPid: args.resourceRootPid || process.ppid, localScope: process.env.IYB_RESOURCE_SCOPE || (process.env.SSH_CONNECTION ? 'remote' : 'local'), remoteTargets: args.remoteResources || [], send: async (id, sample) => {
      const result = await api(config.baseUrl, `/api/goals/${id}/resources`, { method: 'POST', body: sample });
      if (result.supervised === false) { stopSampler?.(); stopSampler = null; }
      return result;
    }, onError: () => {} });
    return textResult(`Goal registered: ${goal.title} (${goal.id}). Work independently and report only advisor-worthy conclusions.`);
  }
  if (name === 'check_advisor') {
    const inbox = await api(config.baseUrl, `/api/sessions/${encodeURIComponent(agentIdentity)}/${encodeURIComponent(sessionIdentity)}/inbox`);
    if (!inbox.directives.length) return textResult('No pending advisor directives. Continue working independently.');
    return textResult(inbox.directives.map((d) => `[${d.kind}] ${d.body}`).join('\n\n'));
  }
  const goalId = args.goalId || await ensureGoal();
  const payload = { ...args, attachments: await encodeAttachments(args.attachments), type: name === 'finish' ? 'FINAL' : name === 'request' ? 'REQUEST' : 'UPDATE' };
  if (name === 'request') {
    payload.bottomLine = `${args.bottomLine}\n\nDecision needed: ${args.question}`;
    payload.blocking = args.blocking !== false;
  }
  const report = await api(config.baseUrl, `/api/goals/${goalId}/reports`, { method: 'POST', body: payload });
  return textResult(name === 'request' ? `Request sent to advisor (${report.id}).${payload.blocking ? ' Pause only work that depends on this decision.' : ' Continue with your recommended path unless directed otherwise.'}` : name === 'finish' ? `Final report sent. Goal marked done (${report.id}).` : `Advisor update sent (${report.id}). Continue working independently.`);
}

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id == null) return;
  try {
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'iamyourboss', version: '0.5.0' } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') result = await callTool(message.params?.name, message.params?.arguments || {});
    else if (message.method === 'ping') result = {};
    else throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    write({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    if (message.method === 'tools/call') write({ jsonrpc: '2.0', id: message.id, result: textResult(error.message, true) });
    else write({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32000, message: error.message } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => { try { void handle(JSON.parse(line)); } catch { /* malformed transport line */ } });
process.on('SIGTERM', () => { stopSampler?.(); process.exit(0); });
