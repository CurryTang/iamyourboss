import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from './config.mjs';
import { install, uninstall } from './install.mjs';
import { api } from './http-client.mjs';
import { installService, uninstallService } from './service.mjs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

const command = process.argv[2] || 'help';
const config = getConfig();
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : null;
}

async function healthy() {
  try { await api(config.baseUrl, '/api/health'); return true; } catch { return false; }
}

async function startServer() {
  if (await healthy()) return false;
  mkdirSync(config.dataDir, { recursive: true });
  const log = openSync(config.logPath, 'a');
  const child = spawn(process.execPath, [serverPath], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let index = 0; index < 30; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await healthy()) return true;
  }
  throw new Error(`Server did not start. See ${config.logPath}`);
}

async function waitForServer() {
  for (let index = 0; index < 40; index += 1) {
    if (await healthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function openBrowser(url) {
  const platform = process.platform;
  const args = platform === 'darwin' ? ['open', url] : platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  spawnSync(args[0], args.slice(1), { stdio: 'ignore' });
}

async function main() {
  if (command === 'submit-report') {
    const goalId = option('goal'); const headline = option('headline'); const bottomLine = option('bottom-line'); const artifact = option('artifact');
    if (!goalId || !headline || !bottomLine || !artifact) throw new Error('submit-report requires --goal, --headline, --bottom-line, and --artifact');
    const mime = ({ '.html':'text/html', '.csv':'text/csv', '.md':'text/markdown', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.pdf':'application/pdf' })[extname(artifact).toLowerCase()] || 'application/octet-stream';
    const report = await api(config.baseUrl, `/api/goals/${goalId}/reports`, { method: 'POST', body: {
      type: String(option('type') || 'UPDATE').toUpperCase(), headline, bottomLine,
      interpretation: option('interpretation'), nextStep: option('next-step'),
      attachments: [{ name: basename(artifact), mimeType: mime, dataBase64: readFileSync(artifact).toString('base64') }],
    } });
    console.log(`Report submitted: ${report.id} · ${report.created_at}`); return;
  }
  if (command === 'install') {
    console.log('\niamyourboss\n');
    const results = install();
    for (const result of results) console.log(`${result.detected ? '✓' : '–'} ${result.name} ${result.detected ? 'detected' : 'not detected'}`);
    console.log('\nInstalling advisor integration...');
    for (const result of results) console.log(`${result.installed ? '✓' : result.detected ? '!' : '–'} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    console.log('✓ Advisor skills — Claude Code · Codex · Cursor Agent · Agy');
    console.log('✓ Native browser + Chat with GPT skills — Claude Code · Codex · Cursor Agent (Agy excluded)');
    const service = installService(config);
    if (service.persistent) {
      if (!await waitForServer()) throw new Error(`Background service did not become healthy. See ${config.logPath}`);
    } else await startServer();
    console.log(`\n${service.persistent ? '✓' : '–'} Background service — ${service.detail}`);
    console.log(`Dashboard: ${config.baseUrl}\n\nDone.`);
    return;
  }
  if (command === 'dashboard') { await startServer(); openBrowser(config.baseUrl); console.log(config.baseUrl); return; }
  if (command === 'serve') {
    const child = spawn(process.execPath, [serverPath], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => process.exit(code ?? 0)); return;
  }
  if (command === 'status') {
    if (!await healthy()) { console.log('iamyourboss is not running.'); process.exitCode = 1; return; }
    const stats = await api(config.baseUrl, '/api/stats');
    console.log(`iamyourboss is running at ${config.baseUrl}\n${stats.goals} active goals · ${stats.needsYou} need you · ${stats.unreadReports} unread reports`); return;
  }
  if (command === 'doctor') {
    const userHome = homedir();
    const claudeHelp = spawnSync('claude', ['--help'], { encoding: 'utf8' });
    const claudeChrome = claudeHelp.status === 0 && `${claudeHelp.stdout || ''}${claudeHelp.stderr || ''}`.includes('--chrome');
    const codexChrome = existsSync(join(userHome, '.codex', 'plugins', 'cache', 'openai-bundled', 'chrome'));
    const cursorAvailable = spawnSync('sh', ['-c', 'command -v cursor-agent || command -v agent'], { stdio: 'ignore' }).status === 0;
    const browserSkills = [join(userHome, '.claude', 'skills'), join(userHome, '.codex', 'skills'), join(userHome, '.cursor', 'skills')]
      .every((root) => existsSync(join(root, 'iyb-chat-with-gpt', 'SKILL.md')) && existsSync(join(root, 'iyb-native-browser-control', 'SKILL.md')));
    const checks = [
      ['Node >= 22.5', Number(process.versions.node.split('.')[0]) >= 22],
      ['Data directory writable', (() => { try { mkdirSync(config.dataDir, { recursive: true }); return true; } catch { return false; } })()],
      ['Claude Code', spawnSync('sh', ['-c', 'command -v claude'], { stdio: 'ignore' }).status === 0],
      ['Codex', spawnSync('sh', ['-c', 'command -v codex'], { stdio: 'ignore' }).status === 0],
      ['Agy', spawnSync('sh', ['-c', 'command -v agy'], { stdio: 'ignore' }).status === 0],
      ['Cursor Agent', cursorAvailable],
      ['Claude native Chrome bridge', claudeChrome],
      ['Codex native Chrome plugin', codexChrome],
      ['Cursor native Browser tool', cursorAvailable],
      ['ChatGPT + browser skills (Claude/Codex/Cursor)', browserSkills],
      ['Boss server', await healthy()],
    ];
    for (const [label, ok] of checks) console.log(`${ok ? '✓' : '–'} ${label}`);
    console.log('  ChatGPT sign-in is verified only through visible browser UI when the skill is used; credentials are never inspected.');
    if (existsSync(config.pidPath)) console.log(`  PID ${readFileSync(config.pidPath, 'utf8').trim()}`);
    return;
  }
  if (command === 'uninstall') { uninstallService(); for (const result of uninstall()) console.log(`${result.removed ? '✓' : '–'} ${result.name}`); return; }
  console.log(`iamyourboss — Your coding agents work. You supervise.\n\nUsage:\n  iyb install\n  iyb dashboard\n  iyb status\n  iyb doctor\n  iyb uninstall\n  iyb serve`);
}

main().catch((error) => { console.error(`iamyourboss: ${error.message}`); process.exitCode = 1; });
