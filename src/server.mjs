#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { getConfig } from './config.mjs';
import { PromptDispatcher } from './dispatcher.mjs';
import { detectRunningSessions } from './session-detector.mjs';
import { sampleLocal } from './resources.mjs';
import { defaultModelForProvider, modelCatalog } from './models.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };
const ARTIFACT_LANGUAGE_NAMES = { 'zh-CN': 'Simplified Chinese (简体中文)', 'zh-TW': 'Traditional Chinese (繁體中文)', en: 'English', ja: 'Japanese (日本語)', ko: 'Korean (한국어)' };
export function reportRequestBody(language = 'zh-CN') { return `Stop at a sensible point and synthesize the current state, even if the goal is incomplete.

Create one self-contained offline HTML progress artifact and attach it to the report. It should communicate the current bottom line, strongest evidence, interpretation or uncertainty, and proposed next step. Include a compact Progress / TODO table with the columns Item, State (done / running / pending / blocked), Evidence or result, and Next action. When quantitative evidence or a trend matters, add a figure plus the exact values; otherwise keep it to one concise lab-meeting-style brief.

Write all human-readable artifact content and report fields in ${ARTIFACT_LANGUAGE_NAMES[language] || ARTIFACT_LANGUAGE_NAMES['zh-CN']}. Preserve code identifiers, commands, paths, and proper nouns exactly when translating them.

Do not include terminal logs, command output, tool-call history, transcripts, token usage, or a chronological activity dump. Then submit exactly one appropriate iamyourboss report, request, or finish call. If this already-running session predates the iamyourboss MCP connection, use the installed \`iyb submit-report\` fallback with the supplied goal record ID and artifact path instead of writing the result only to the terminal.`; }
export const REPORT_REQUEST_BODY = reportRequestBody();

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 30_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApp(options = {}) {
  const config = { ...getConfig(), ...options };
  mkdirSync(config.dataDir, { recursive: true });
  const store = options.store || new Store(config);
  const streams = new Set();
  const changed = (kind, id) => {
    const payload = `event: change\ndata: ${JSON.stringify({ kind, id, at: new Date().toISOString() })}\n\n`;
    for (const stream of streams) stream.write(payload);
  };
  const dispatcher = options.dispatcher || new PromptDispatcher({ store, changed });
  const sessionDetector = options.sessionDetector || (options.store ? () => [] : detectRunningSessions);
  let lastSessionScan = 0;
  const refreshSessions = () => {
    if (Date.now() - lastSessionScan > 5000) { store.syncSessions(sessionDetector()); lastSessionScan = Date.now(); }
    return store.sessions().map((session) => ({ ...session, effective_model: session.model || defaultModelForProvider(session.provider), model_source: session.model ? 'advisor' : 'provider-default' }));
  };
  const activateSupervision = (session, requestReport = true) => {
    const record = store.getSession(session.id);
    let goal = [...record.goals].reverse().find((entry) => !entry.goal.archived_at && !entry.goal.completed_at)?.goal || null;
    if (!goal) {
      const project = basename(session.working_directory || '') || session.provider_name || `${session.provider} session`;
      goal = store.createGoal({ title: project, originalGoal: `Continue supervising this existing ${session.provider} session. Synthesize its current progress, completed work, TODOs, blockers, evidence, and next step without exposing terminal logs or internal traces.`, agent: session.provider, sessionKey: session.session_key, resumeId: session.session_key, workingDirectory: session.working_directory, terminalTransport: session.terminal_transport, terminalSession: session.terminal_session, terminalPane: session.terminal_pane, pid: session.pid, role: session.role, supervised: true });
    }
    let directive = null;
    if (requestReport) {
      directive = store.addDirective(goal.id, { body: reportRequestBody(session.artifact_language), kind: 'REPORT_REQUEST' });
      changed('report-request', directive.id); dispatcher.dispatch(goal.id, directive);
    }
    return { goal, directive };
  };
  for (const session of refreshSessions().filter((item) => item.supervised && !item.active_goal)) activateSupervision(session);
  let resourceSampleRunning = false;
  const sampleSupervisedSessions = async () => {
    if (resourceSampleRunning) return;
    resourceSampleRunning = true;
    try {
      const targets = refreshSessions().filter((session) => session.supervised && session.running === true && session.pid && session.active_goal);
      await Promise.allSettled(targets.map(async (session) => {
        const sample = await sampleLocal(session.pid, 'local');
        const saved = store.addResourceSample(session.active_goal.id, sample);
        if (saved) changed('resource', session.active_goal.id);
      }));
    } finally { resourceSampleRunning = false; }
  };
  const resourceTimer = setInterval(() => { void sampleSupervisedSessions(); }, options.resourceSampleIntervalMs || 10_000);
  resourceTimer.unref();
  void sampleSupervisedSessions();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    try {
      if (path === '/api/health') return sendJson(res, 200, { ok: true, version: '0.4.0' });
      if (path === '/api/stats') return sendJson(res, 200, store.stats());
      if (path === '/api/dashboard' && req.method === 'GET') return sendJson(res, 200, { ...store.dashboard({ includeArchived: url.searchParams.get('archived') === '1' }), sessions: refreshSessions() });
      if (path === '/api/sessions' && req.method === 'GET') return sendJson(res, 200, refreshSessions());
      if (path === '/api/models' && req.method === 'GET') return sendJson(res, 200, modelCatalog(url.searchParams.get('provider') || ''));
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
      }
      if (path === '/api/goals' && req.method === 'POST') {
        const goal = store.createGoal(await body(req)); changed('goal', goal.id); return sendJson(res, 201, goal);
      }
      let match = path.match(/^\/api\/goals\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const result = store.getGoal(match[1]); if (!result) return sendJson(res, 404, { error: 'Goal not found' });
        return sendJson(res, 200, result);
      }
      match = path.match(/^\/api\/goals\/([^/]+)\/reports$/);
      if (match && req.method === 'POST') {
        const report = store.addReport(match[1], await body(req)); changed('report', report.id); return sendJson(res, 201, report);
      }
      match = path.match(/^\/api\/reports\/([^/]+)\/seen$/);
      if (match && req.method === 'POST') { const report = store.markSeen(match[1]); changed('seen', match[1]); return sendJson(res, 200, report); }
      match = path.match(/^\/api\/goals\/([^/]+)\/directives$/);
      if (match && req.method === 'POST') { const item = store.addDirective(match[1], await body(req)); changed('directive', item.id); dispatcher.dispatch(match[1], item); return sendJson(res, 201, item); }
      match = path.match(/^\/api\/goals\/([^/]+)\/request-report$/);
      if (match && req.method === 'POST') {
        const goal = store.getGoal(match[1]); if (!goal) return sendJson(res, 404, { error: 'Goal not found' });
        const language = store.getSession(goal.goal.session_id)?.session.artifact_language || 'zh-CN';
        const item = store.addDirective(match[1], { body: reportRequestBody(language), kind: 'REPORT_REQUEST' });
        changed('report-request', item.id); dispatcher.dispatch(match[1], item); return sendJson(res, 201, item);
      }
      match = path.match(/^\/api\/reports\/([^/]+)\/decision$/);
      if (match && req.method === 'POST') { const item = store.answerRequest(match[1], await body(req)); changed('decision', item.id); const report = store.getReport(match[1]); dispatcher.dispatch(report.goal_id, item.directive); return sendJson(res, 201, item); }
      match = path.match(/^\/api\/goals\/([^/]+)\/archive$/);
      if (match && req.method === 'POST') { store.archiveGoal(match[1]); changed('archive', match[1]); return sendJson(res, 200, { ok: true }); }
      match = path.match(/^\/api\/goals\/([^/]+)\/resources$/);
      if (match && req.method === 'POST') { const item = store.addResourceSample(match[1], await body(req)); if (item) changed('resource', match[1]); return sendJson(res, item ? 201 : 202, item || { ignored: true, supervised: false }); }
      if (path === '/api/sessions/identify' && req.method === 'POST') { const item = store.identifySession(await body(req)); changed('session-identify', item.id); return sendJson(res, 200, item); }
      match = path.match(/^\/api\/sessions\/([^/]+)\/supervise$/);
      if (match && req.method === 'POST') {
        const input = await body(req); const item = store.setSessionSupervised(match[1], input.supervised); changed('session-supervise', match[1]);
        let goal = null; let directive = null;
        if (item.supervised) {
          ({ goal, directive } = activateSupervision(item)); void sampleSupervisedSessions();
        }
        return sendJson(res, 200, { session: item, goal, directive });
      }
      match = path.match(/^\/api\/sessions\/([^/]+)\/star$/);
      if (match && req.method === 'POST') { const input = await body(req); const item = store.setSessionStar(match[1], input.starred); changed('session-star', match[1]); return sendJson(res, 200, item); }
      match = path.match(/^\/api\/sessions\/([^/]+)\/settings$/);
      if (match && req.method === 'POST') { const input = await body(req); const item = store.setSessionSettings(match[1], input); changed('session-settings', match[1]); return sendJson(res, 200, item); }
      match = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (match && req.method === 'GET') { refreshSessions(); const item = store.getSession(match[1]); if (item) { item.session.effective_model = item.session.model || defaultModelForProvider(item.session.provider); item.session.model_source = item.session.model ? 'advisor' : 'provider-default'; } return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'Session not found' }); }
      match = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/inbox$/);
      if (match && req.method === 'GET') return sendJson(res, 200, store.inbox(decodeURIComponent(match[1]), decodeURIComponent(match[2]), url.searchParams.get('peek') !== '1'));
      match = path.match(/^\/api\/attachments\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const attachment = store.attachment(match[1]);
        if (!attachment || !existsSync(attachment.stored_path)) return sendJson(res, 404, { error: 'Attachment not found' });
        const contentType = attachment.mime_type || MIME[extname(attachment.filename)] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': contentType, 'content-disposition': `inline; filename="${attachment.filename.replace(/"/g, '')}"`, ...(contentType.startsWith('text/html') ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'" } : {}) });
        return createReadStream(attachment.stored_path).pipe(res);
      }
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const requested = path === '/' ? 'index.html' : path.slice(1);
        const filePath = resolve(publicDir, requested);
        const safePath = filePath.startsWith(`${publicDir}/`) || filePath === join(publicDir, 'index.html') ? filePath : join(publicDir, 'index.html');
        const actual = existsSync(safePath) ? safePath : join(publicDir, 'index.html');
        res.writeHead(200, { 'content-type': MIME[extname(actual)] || 'application/octet-stream' });
        return createReadStream(actual).pipe(res);
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = /not supervised|Supervise the session/i.test(error.message) ? 409 : /required|must be|not found|already answered|too large|Unexpected token/i.test(error.message) ? 400 : 500;
      sendJson(res, status, { error: error.message });
    }
  });

  server.on('close', () => { clearInterval(resourceTimer); for (const stream of streams) stream.end(); if (!options.store) store.close(); });
  return { server, store, config };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, config } = createApp();
  server.listen(config.port, config.host, () => {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(config.pidPath, String(process.pid));
    console.log(`iamyourboss listening at http://${config.host}:${config.port}`);
  });
}
