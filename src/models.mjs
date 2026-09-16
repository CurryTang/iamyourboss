import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cache = new Map();
const unique = (items) => [...new Map(items.filter((item) => item?.id).map((item) => [item.id, item])).values()];

function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
function codexDefault(home) {
  try { return readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/^model\s*=\s*["']([^"']+)/m)?.[1] || null; } catch { return null; }
}
export function defaultModelForProvider(provider, home = homedir()) {
  if (provider === 'Claude Code') return json(join(home, '.claude', 'settings.json')).model || null;
  if (provider === 'Codex') return codexDefault(home);
  if (provider === 'Cursor Agent') return json(join(home, '.cursor', 'cli-config.json')).model?.modelId || null;
  return null;
}
function commandModels(provider) {
  const command = provider === 'Cursor Agent' ? ['cursor-agent', ['--list-models']] : provider === 'Agy' ? ['agy', ['models']] : null;
  if (!command) return [];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) return [];
  return String(result.stdout || '').split('\n').map((line) => {
    const cursor = line.match(/^([^\s]+)\s+-\s+(.+)$/); if (cursor) return { id: cursor[1], label: cursor[2] };
    const agy = line.match(/^([^\t\s]+)\t(.+)$/); if (agy) return { id: agy[1], label: agy[2] };
    return null;
  }).filter(Boolean);
}

export function modelCatalog(provider, { home = homedir(), refresh = false } = {}) {
  const cached = cache.get(provider); if (!refresh && cached && Date.now() - cached.at < 300_000) return structuredClone(cached.value);
  const defaultModel = defaultModelForProvider(provider, home);
  const fallbacks = provider === 'Claude Code'
    ? [{ id:'sonnet', label:'Claude Sonnet' }, { id:'opus', label:'Claude Opus' }, { id:'haiku', label:'Claude Haiku' }]
    : provider === 'Codex'
      ? [{ id:'gpt-5.6-sol', label:'GPT-5.6 Sol' }, { id:'gpt-5.6-terra', label:'GPT-5.6 Terra' }, { id:'gpt-5.6-luna', label:'GPT-5.6 Luna' }]
      : [];
  const models = unique([{ id: defaultModel, label: defaultModel ? `${defaultModel} (provider default)` : null }, ...commandModels(provider), ...fallbacks]);
  const value = { provider, defaultModel, models }; cache.set(provider, { at: Date.now(), value }); return structuredClone(value);
}
