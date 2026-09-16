import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MANAGED_END, MANAGED_START, managedInstructions } from './advisor-instructions.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const mcpPath = join(packageRoot, 'src', 'mcp.mjs');
const hookPath = join(packageRoot, 'src', 'hook.mjs');
const sharedSkillsPath = join(packageRoot, 'plugins', 'iamyourboss', 'skills');
const managedSkillMarker = '.iamyourboss-managed';
const noAgySkills = new Set(['chat-with-gpt', 'native-browser-control']);

function sharedSkillLocations(home) {
  return [
    { provider: 'claude', root: join(home, '.claude', 'skills') },
    { provider: 'codex', root: join(home, '.codex', 'skills') },
    { provider: 'cursor', root: join(home, '.cursor', 'skills') },
    { provider: 'agy', root: join(home, '.gemini', 'config', 'skills') },
  ];
}

function managedSkillLocations(home) {
  return [...sharedSkillLocations(home), { provider: 'cursor-legacy', root: join(home, '.cursor', 'skills-cursor') }];
}

function installSharedSkills(home) {
  if (!existsSync(sharedSkillsPath)) return [];
  const skills = readdirSync(sharedSkillsPath, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
  const legacyCursorRoot = join(home, '.cursor', 'skills-cursor');
  if (existsSync(legacyCursorRoot)) {
    for (const item of readdirSync(legacyCursorRoot, { withFileTypes: true })) {
      const target = join(legacyCursorRoot, item.name);
      if (item.isDirectory() && item.name.startsWith('iyb-') && existsSync(join(target, managedSkillMarker))) rmSync(target, { recursive: true, force: true });
    }
  }
  for (const { provider, root } of sharedSkillLocations(home)) {
    mkdirSync(root, { recursive: true });
    for (const skill of skills) {
      const target = join(root, `iyb-${skill}`);
      if (provider === 'agy' && noAgySkills.has(skill)) {
        if (existsSync(join(target, managedSkillMarker))) rmSync(target, { recursive: true, force: true });
        continue;
      }
      if (existsSync(target) && !existsSync(join(target, managedSkillMarker))) continue;
      rmSync(target, { recursive: true, force: true });
      cpSync(join(sharedSkillsPath, skill), target, { recursive: true });
      const skillFile = join(target, 'SKILL.md');
      let content = readFileSync(skillFile, 'utf8').replace(/^name:\s*([^\n]+)$/m, `name: iyb-${skill}`);
      for (const related of skills) content = content.replaceAll(`$${related}`, `$iyb-${related}`);
      writeFileSync(skillFile, content);
      writeFileSync(join(target, managedSkillMarker), 'managed by iamyourboss\n');
    }
  }
  return skills;
}

function uninstallSharedSkills(home) {
  for (const { root } of managedSkillLocations(home)) {
    if (!existsSync(root)) continue;
    for (const item of readdirSync(root, { withFileTypes: true })) {
      const target = join(root, item.name);
      if (item.isDirectory() && item.name.startsWith('iyb-') && existsSync(join(target, managedSkillMarker))) rmSync(target, { recursive: true, force: true });
    }
  }
}

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function upsertManagedBlock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const regex = new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}\\n?`, 'g');
  const clean = original.replace(regex, '').trimEnd();
  writeFileSync(path, `${clean}${clean ? '\n\n' : ''}${managedInstructions()}\n`);
}

function removeManagedBlock(path) {
  if (!existsSync(path)) return;
  const original = readFileSync(path, 'utf8');
  const regex = new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}\\n?`, 'g');
  writeFileSync(path, original.replace(regex, '').trimEnd() + (original.replace(regex, '').trim() ? '\n' : ''));
}

function upsertHooks(settingsPath, command) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  settings.hooks ||= {};
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const filtered = groups.filter((group) => !group?.hooks?.some((hook) => String(hook.command || '').includes('/iamyourboss/src/hook.mjs')));
    filtered.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] });
    settings.hooks[event] = filtered;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function installClaude(home) {
  const available = commandExists('claude');
  if (!available) return { name: 'Claude Code', detected: false, installed: false, detail: 'CLI not found' };
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'iamyourboss'], { stdio: 'ignore' });
  const add = spawnSync('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'iamyourboss', '-e', 'IYB_AGENT=Claude Code', '--', process.execPath, mcpPath], { encoding: 'utf8' });
  upsertManagedBlock(join(home, '.claude', 'CLAUDE.md'));
  upsertHooks(join(home, '.claude', 'settings.json'), `${process.execPath} ${hookPath} --agent "Claude Code"`);
  return { name: 'Claude Code', detected: true, installed: add.status === 0, detail: add.status === 0 ? 'MCP + advisor hook' : (add.stderr || add.stdout || 'MCP registration failed').trim() };
}

function installCodex(home) {
  const available = commandExists('codex');
  if (!available) return { name: 'Codex', detected: false, installed: false, detail: 'CLI not found' };
  spawnSync('codex', ['mcp', 'remove', 'iamyourboss'], { stdio: 'ignore' });
  const add = spawnSync('codex', ['mcp', 'add', '--env', 'IYB_AGENT=Codex', 'iamyourboss', '--', process.execPath, mcpPath], { encoding: 'utf8' });
  upsertManagedBlock(join(home, '.codex', 'AGENTS.md'));
  upsertHooks(join(home, '.codex', 'hooks.json'), `${process.execPath} ${hookPath} --agent Codex`);
  spawnSync('codex', ['features', 'enable', 'hooks'], { stdio: 'ignore' });
  return { name: 'Codex', detected: true, installed: add.status === 0, detail: add.status === 0 ? 'MCP + automatic advisor hook' : (add.stderr || add.stdout || 'MCP registration failed').trim() };
}

function installAgy(home) {
  const available = commandExists('agy');
  if (!available) return { name: 'Agy', detected: false, installed: false, detail: 'CLI not found' };
  spawnSync('agy', ['mcp', 'remove', 'iamyourboss'], { stdio: 'ignore' });
  const add = spawnSync('agy', ['mcp', 'add', '--env', 'IYB_AGENT=Agy', 'iamyourboss', process.execPath, mcpPath], { encoding: 'utf8' });
  upsertManagedBlock(join(home, '.gemini', 'config', 'GEMINI.md'));
  const hooksPath = join(home, '.gemini', 'config', 'hooks.json');
  mkdirSync(dirname(hooksPath), { recursive: true });
  let hooks = {};
  try { hooks = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch {}
  hooks.iamyourboss = { PreInvocation: [{ type: 'command', command: `${process.execPath} ${hookPath} --agent Agy --format agy --event PreInvocation`, timeout: 5 }] };
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  return { name: 'Agy', detected: true, installed: add.status === 0, detail: add.status === 0 ? 'MCP + PreInvocation advisor hook' : (add.stderr || add.stdout || 'MCP registration failed').trim() };
}

function installCursor(home) {
  const executable = commandExists('cursor-agent') ? 'cursor-agent' : commandExists('agent') ? 'agent' : null;
  if (!executable) return { name: 'Cursor Agent', detected: false, installed: false, detail: 'CLI not found' };
  const cursorDir = join(home, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  const mcpConfigPath = join(cursorDir, 'mcp.json');
  let mcp = {};
  try { mcp = JSON.parse(readFileSync(mcpConfigPath, 'utf8')); } catch {}
  mcp.mcpServers ||= {};
  mcp.mcpServers.iamyourboss = { command: process.execPath, args: [mcpPath], env: { IYB_AGENT: 'Cursor Agent' } };
  writeFileSync(mcpConfigPath, `${JSON.stringify(mcp, null, 2)}\n`); chmodSync(mcpConfigPath, 0o600);
  const hooksPath = join(cursorDir, 'hooks.json');
  let hooks = { version: 1, hooks: {} };
  try { hooks = { version: 1, ...JSON.parse(readFileSync(hooksPath, 'utf8')) }; } catch {}
  hooks.hooks ||= {};
  const existing = Array.isArray(hooks.hooks.sessionStart) ? hooks.hooks.sessionStart : [];
  hooks.hooks.sessionStart = [...existing.filter((item) => !String(item.command || '').includes('/iamyourboss/src/hook.mjs')), { command: `${process.execPath} ${hookPath} --agent "Cursor Agent" --format cursor` }];
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  const rulePath = join(cursorDir, 'rules', 'iamyourboss.mdc');
  mkdirSync(dirname(rulePath), { recursive: true });
  writeFileSync(rulePath, `---\ndescription: Asynchronous advisor reporting behavior\nalwaysApply: true\n---\n\n${managedInstructions()}\n`);
  spawnSync(executable, ['mcp', 'enable', 'iamyourboss'], { stdio: 'ignore' });
  return { name: 'Cursor Agent', detected: true, installed: true, detail: 'MCP + sessionStart advisor hook' };
}

export function install({ home = homedir() } = {}) {
  installSharedSkills(home);
  return [installClaude(home), installCodex(home), installAgy(home), installCursor(home)];
}

export function uninstall({ home = homedir() } = {}) {
  const results = [];
  uninstallSharedSkills(home);
  if (commandExists('claude')) {
    const result = spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'iamyourboss'], { encoding: 'utf8' });
    results.push({ name: 'Claude Code', removed: result.status === 0 });
  }
  if (commandExists('codex')) {
    const result = spawnSync('codex', ['mcp', 'remove', 'iamyourboss'], { encoding: 'utf8' });
    results.push({ name: 'Codex', removed: result.status === 0 });
  }
  if (commandExists('agy')) {
    const result = spawnSync('agy', ['mcp', 'remove', 'iamyourboss'], { encoding: 'utf8' });
    results.push({ name: 'Agy', removed: result.status === 0 });
  }
  removeManagedBlock(join(home, '.claude', 'CLAUDE.md'));
  removeManagedBlock(join(home, '.codex', 'AGENTS.md'));
  removeManagedBlock(join(home, '.gemini', 'config', 'GEMINI.md'));
  const settingsPath = join(home, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      for (const event of ['SessionStart', 'UserPromptSubmit']) {
        if (Array.isArray(settings.hooks?.[event])) settings.hooks[event] = settings.hooks[event].filter((group) => !group?.hooks?.some((hook) => String(hook.command || '').includes('/iamyourboss/src/hook.mjs')));
      }
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch {}
  }
  const codexHooksPath = join(home, '.codex', 'hooks.json');
  if (existsSync(codexHooksPath)) {
    try {
      const settings = JSON.parse(readFileSync(codexHooksPath, 'utf8'));
      for (const event of ['SessionStart', 'UserPromptSubmit']) {
        if (Array.isArray(settings.hooks?.[event])) settings.hooks[event] = settings.hooks[event].filter((group) => !group?.hooks?.some((hook) => String(hook.command || '').includes('/iamyourboss/src/hook.mjs')));
      }
      writeFileSync(codexHooksPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch {}
  }
  const agyHooksPath = join(home, '.gemini', 'config', 'hooks.json');
  if (existsSync(agyHooksPath)) {
    try { const hooks = JSON.parse(readFileSync(agyHooksPath, 'utf8')); delete hooks.iamyourboss; writeFileSync(agyHooksPath, `${JSON.stringify(hooks, null, 2)}\n`); } catch {}
  }
  const cursorMcpPath = join(home, '.cursor', 'mcp.json');
  if (existsSync(cursorMcpPath)) {
    try { const mcp = JSON.parse(readFileSync(cursorMcpPath, 'utf8')); if (mcp.mcpServers) delete mcp.mcpServers.iamyourboss; writeFileSync(cursorMcpPath, `${JSON.stringify(mcp, null, 2)}\n`); } catch {}
  }
  const cursorHooksPath = join(home, '.cursor', 'hooks.json');
  if (existsSync(cursorHooksPath)) {
    try { const hooks = JSON.parse(readFileSync(cursorHooksPath, 'utf8')); if (Array.isArray(hooks.hooks?.sessionStart)) hooks.hooks.sessionStart = hooks.hooks.sessionStart.filter((item) => !String(item.command || '').includes('/iamyourboss/src/hook.mjs')); writeFileSync(cursorHooksPath, `${JSON.stringify(hooks, null, 2)}\n`); } catch {}
  }
  const cursorRulePath = join(home, '.cursor', 'rules', 'iamyourboss.mdc');
  if (existsSync(cursorRulePath)) unlinkSync(cursorRulePath);
  if (commandExists('cursor-agent') || commandExists('agent')) results.push({ name: 'Cursor Agent', removed: true });
  return results;
}

export const paths = { packageRoot, mcpPath, hookPath, sharedSkillsPath };
