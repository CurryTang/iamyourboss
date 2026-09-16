import { execFileSync } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { basename } from 'node:path';
import { readFileSync, readlinkSync } from 'node:fs';

const ENV_KEYS = [
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'CURSOR_SESSION_ID', 'CURSOR_CHAT_ID',
  'AGY_CONVERSATION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'IYB_SESSION_ID', 'IYB_PARENT_SESSION_ID',
  'CLAUDE_PARENT_SESSION_ID', 'CURSOR_PARENT_SESSION_ID', 'CODEX_PARENT_THREAD_ID', 'AGY_PARENT_CONVERSATION_ID',
  'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'TMUX_PANE',
];

function elapsedSeconds(value = '') {
  const parts = value.trim().split('-');
  const days = parts.length === 2 ? Number(parts.shift()) : 0;
  const time = parts[0].split(':').map(Number);
  const [hours, minutes, seconds] = time.length === 3 ? time : [0, time[0] || 0, time[1] || 0];
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function providerFor(command = '') {
  const first = command.trim().split(/\s+/)[0] || '';
  const executable = basename(first).toLowerCase();
  const lower = command.toLowerCase();
  if (executable === 'claude' && !lower.includes('--chrome-native-host')) return 'Claude Code';
  if (executable === 'codex' && !/\bcodex\s+(?:mcp-server|app-server)\b/.test(lower) && !lower.includes('codex-code-mode-host')) return 'Codex';
  if ((executable === 'agy' || executable === 'antigravity') && !lower.includes('language-server')) return 'Agy';
  if ((executable === 'agent' || lower.includes('cursor-agent')) && (lower.includes('cursor-agent') || lower.includes('/cursor-agent/'))) return 'Cursor Agent';
  return null;
}

function providerSessionId(provider, env, command, pid, startedAt) {
  const keys = provider === 'Codex' ? ['CODEX_THREAD_ID','CODEX_SESSION_ID']
    : provider === 'Claude Code' ? ['CLAUDE_SESSION_ID']
      : provider === 'Cursor Agent' ? ['CURSOR_SESSION_ID','CURSOR_CHAT_ID']
        : ['AGY_CONVERSATION_ID','ANTIGRAVITY_CONVERSATION_ID'];
  for (const key of ['IYB_SESSION_ID', ...keys]) if (env[key]) return { value: env[key], authoritative: true };
  if (provider === 'Agy') {
    const match = command.match(/--conversation(?:=|\s+)([^\s]+)/);
    if (match) return { value: match[1], authoritative: true };
  }
  return { value: `process-${pid}-${Date.parse(startedAt)}`, authoritative: false };
}

function parentKey(env) {
  for (const key of ['IYB_PARENT_SESSION_ID','CLAUDE_PARENT_SESSION_ID','CURSOR_PARENT_SESSION_ID','CODEX_PARENT_THREAD_ID','AGY_PARENT_CONVERSATION_ID']) {
    if (env[key]) return env[key];
  }
  return null;
}

export function parseProcessRows(output = '') {
  return output.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), tty: match[3], elapsed: match[4], command: match[5] } : null;
  }).filter(Boolean);
}

export function classifySessions(rows, { envForPid = () => ({}), cwdForPid = () => null, providerSessionForPid = () => null, host = hostname(), now = Date.now() } = {}) {
  const scanNow = Math.floor(now / 1000) * 1000;
  const allByPid = new Map(rows.map((row) => [row.pid, row]));
  const candidates = rows.map((row) => ({ row, provider: providerFor(row.command) })).filter((item) => item.provider).map((item) => {
    const env = envForPid(item.row.pid) || {};
    const startedAt = new Date(scanNow - elapsedSeconds(item.row.elapsed) * 1000).toISOString();
    const providerSession = providerSessionForPid(item.row.pid, item.provider);
    const identity = providerSession?.sessionId ? { value: providerSession.sessionId, authoritative: true } : providerSessionId(item.provider, env, item.row.command, item.row.pid, startedAt);
    return { ...item, env, startedAt, identity, providerSession };
  });
  const candidateByPid = new Map(candidates.map((item) => [item.row.pid, item]));
  return candidates.map(({ row, provider, env, startedAt, identity, providerSession }) => {
    let ancestor = allByPid.get(row.ppid); let parent = null;
    while (ancestor) {
      if (candidateByPid.has(ancestor.pid)) { parent = candidateByPid.get(ancestor.pid); break; }
      ancestor = allByPid.get(ancestor.ppid);
    }
    const explicitParent = parentKey(env);
    const flaggedSubagent = /(?:--subagent\b|\bsubagent(?:=|\s))/i.test(row.command);
    const role = explicitParent || parent || flaggedSubagent ? 'SUBAGENT' : 'MAIN';
    const terminalTransport = env.ZELLIJ_SESSION_NAME ? 'zellij' : env.TMUX_PANE ? 'tmux' : null;
    return {
      runtime_key: `${host}:${provider}:${identity.value}`,
      provider, session_key: identity.value, identity_authoritative: identity.authoritative,
      pid: row.pid, ppid: row.ppid, tty: row.tty === '??' || row.tty === '?' ? null : row.tty,
      role, role_source: explicitParent ? 'provider' : parent || flaggedSubagent ? 'process' : 'process-root',
      parent_session_key: explicitParent || parent?.identity.value || null,
      working_directory: cwdForPid(row.pid), command_name: basename(row.command.trim().split(/\s+/)[0] || provider),
      terminal_transport: terminalTransport, terminal_session: env.ZELLIJ_SESSION_NAME || null,
      terminal_pane: env.ZELLIJ_PANE_ID || env.TMUX_PANE || null,
      provider_status: providerSession?.status || null, provider_name: providerSession?.name || null,
      host, started_at: startedAt, last_seen_at: new Date(scanNow).toISOString(), running: true,
    };
  });
}

function claudeAgentSessions() {
  try {
    const raw = execFileSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
    return new Map(JSON.parse(raw).filter((item) => item?.pid && item?.sessionId).map((item) => [Number(item.pid), item]));
  } catch { return new Map(); }
}

function processEnvironment(pid) {
  if (platform() !== 'darwin') {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
      return Object.fromEntries(raw.split('\0').map((part) => { const at = part.indexOf('='); return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]; }).filter(([key]) => ENV_KEYS.includes(key)));
    } catch { return {}; }
  }
  try {
    const raw = execFileSync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1200, maxBuffer: 2 * 1024 * 1024 });
    const result = {};
    for (const key of ENV_KEYS) {
      const match = raw.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
      if (match) result[key] = match[1];
    }
    return result;
  } catch { return {}; }
}

function processCwd(pid) {
  if (platform() === 'linux') { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  try {
    const raw = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1200, maxBuffer: 64 * 1024 });
    return raw.split('\n').find((line) => line.startsWith('n'))?.slice(1) || null;
  } catch { return null; }
}

export function detectRunningSessions() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,tty=,etime=,args='], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const claudeSessions = claudeAgentSessions();
  return classifySessions(parseProcessRows(output), { envForPid: processEnvironment, cwdForPid: processCwd, providerSessionForPid: (pid, provider) => provider === 'Claude Code' ? claudeSessions.get(pid) || null : null });
}
