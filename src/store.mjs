import { mkdirSync, copyFileSync, writeFileSync, readFileSync, renameSync, statSync, chmodSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REPORT_TYPES = new Set(['UPDATE', 'REQUEST', 'FINAL']);
const ARTIFACT_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko']);
const EMPTY = { sessions: [], goals: [], reports: [], directives: [], decisions: [], attachments: [], resources: [], resourceCounter: 0 };
const now = () => new Date().toISOString();
function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function clone(value) { return structuredClone(value); }

export class Store {
  constructor({ dbPath, attachmentsDir, staleMinutes = 180 }) {
    this.dbPath = dbPath; this.attachmentsDir = attachmentsDir; this.staleMinutes = staleMinutes;
    mkdirSync(attachmentsDir, { recursive: true });
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    try { this.data = { ...clone(EMPTY), ...JSON.parse(readFileSync(dbPath, 'utf8')) }; } catch { this.data = clone(EMPTY); }
    let recovered = false;
    for (const goal of this.data.goals) {
      let session = goal.session_id ? this.data.sessions.find((item) => item.id === goal.session_id) : null;
      if (!goal.session_id) {
        session = this.upsertRegisteredSession({
          workingDirectory: goal.working_directory, terminalTransport: goal.terminal_transport,
          terminalSession: goal.terminal_session, terminalPane: goal.terminal_pane,
        }, goal.agent, goal.session_key);
        goal.session_id = session.id;
        recovered = true;
      }
      if (session && session.supervised == null) { session.supervised = !goal.archived_at && !goal.completed_at; recovered = true; }
    }
    for (const session of this.data.sessions) {
      if (session.supervised == null) { session.supervised = false; recovered = true; }
      if (!ARTIFACT_LANGUAGES.has(session.artifact_language)) { session.artifact_language = 'zh-CN'; recovered = true; }
      if (session.model === undefined) { session.model = null; recovered = true; }
    }
    for (const directive of this.data.directives) {
      if (directive.dispatch_status === 'RUNNING') { directive.dispatch_status = 'FAILED'; directive.dispatch_error = 'Advisor server restarted before delivery was confirmed.'; recovered = true; }
    }
    if (recovered) this.persist();
  }
  persist() {
    if (this.dbPath === ':memory:') return;
    const temporary = `${this.dbPath}.next`;
    writeFileSync(temporary, `${JSON.stringify(this.data)}\n`, { mode: 0o600 }); renameSync(temporary, this.dbPath);
  }
  close() { this.persist(); }
  createGoal(input) {
    const agent = required(input.agent, 'agent'); const sessionKey = required(input.sessionKey, 'sessionKey');
    const existing = this.data.goals.find((goal) => goal.agent === agent && goal.session_key === sessionKey);
    if (existing) {
      if (!existing.session_id) existing.session_id = this.upsertRegisteredSession(input, agent, sessionKey).id;
      this.persist(); return clone(existing);
    }
    const at = now();
    const session = this.upsertRegisteredSession(input, agent, sessionKey);
    if (!session.supervised && input.supervised !== true) throw new Error('Session is not supervised. Select it in the advisor dashboard first.');
    if (input.supervised === true) session.supervised = true;
    const goal = {
      id: randomUUID(), title: required(input.title, 'title'), original_goal: required(input.originalGoal, 'originalGoal'),
      agent, session_key: sessionKey, resume_id: input.resumeId || sessionKey, prompt_transport: input.promptTransport || null,
      terminal_transport: input.terminalTransport || null, terminal_session: input.terminalSession || null,
      terminal_pane: input.terminalPane == null ? null : String(input.terminalPane),
      session_id: session.id,
      repository: input.repository || null, working_directory: input.workingDirectory || null,
      started_at: at, completed_at: null, archived_at: null, last_agent_at: at,
    };
    this.data.goals.push(goal); this.persist(); return clone(goal);
  }
  upsertRegisteredSession(input, provider, sessionKey) {
    let session = this.data.sessions.find((item) => item.provider === provider && item.session_key === sessionKey);
    if (!session && input.pid) session = this.data.sessions.find((item) => item.provider === provider && item.pid === Number(input.pid));
    if (!session && input.terminalTransport && input.terminalSession && input.terminalPane != null) {
      session = this.data.sessions.find((item) => item.provider === provider && item.terminal_transport === input.terminalTransport && item.terminal_session === input.terminalSession && String(item.terminal_pane) === String(input.terminalPane));
    }
    if (!session && input.workingDirectory) {
      const candidates = this.data.sessions.filter((item) => item.provider === provider && item.running === true && item.working_directory === input.workingDirectory);
      if (candidates.length === 1) session = candidates[0];
    }
    const at = now();
    const identityAuthoritative = input.identityAuthoritative ?? !String(sessionKey).startsWith('process-');
    if (!session) {
      session = { id: randomUUID(), runtime_key: null, provider, session_key: sessionKey, identity_authoritative: identityAuthoritative, role: input.role === 'SUBAGENT' ? 'SUBAGENT' : 'MAIN', role_source: input.role ? 'provider' : 'registration', parent_session_key: input.parentSessionKey || null, parent_session_id: null, starred: false, supervised: Boolean(input.supervised), artifact_language: 'zh-CN', model: null, registered: true, running: null, first_seen_at: at };
      this.data.sessions.push(session);
    }
    Object.assign(session, {
      provider, session_key: sessionKey, identity_authoritative: identityAuthoritative, registered: true,
      working_directory: input.workingDirectory || session.working_directory || null,
      terminal_transport: input.terminalTransport || session.terminal_transport || null,
      terminal_session: input.terminalSession || session.terminal_session || null,
      terminal_pane: input.terminalPane == null ? session.terminal_pane || null : String(input.terminalPane),
      pid: input.pid ? Number(input.pid) : session.pid || null,
      role: input.role || session.role || 'MAIN',
      parent_session_key: input.parentSessionKey || session.parent_session_key || null,
      supervised: Boolean(session.supervised || input.supervised),
      last_seen_at: at,
    });
    return session;
  }
  syncSessions(discovered = []) {
    const seen = new Set();
    for (const item of discovered) {
      let session = this.data.sessions.find((entry) => entry.runtime_key === item.runtime_key || (entry.provider === item.provider && entry.pid === item.pid) || (item.identity_authoritative && entry.provider === item.provider && entry.session_key === item.session_key));
      if (!session && item.terminal_transport && item.terminal_session && item.terminal_pane != null) {
        session = this.data.sessions.find((entry) => entry.provider === item.provider && entry.terminal_transport === item.terminal_transport && entry.terminal_session === item.terminal_session && String(entry.terminal_pane) === String(item.terminal_pane));
      }
      if (!session) {
        session = { id: randomUUID(), starred: false, supervised: false, artifact_language: 'zh-CN', model: null, registered: false, first_seen_at: item.last_seen_at };
        this.data.sessions.push(session);
      }
      const replaceProcessIdentity = item.identity_authoritative && String(session.session_key || '').startsWith('process-');
      const preservedKey = session.registered && session.identity_authoritative && !replaceProcessIdentity ? session.session_key : item.session_key;
      if (replaceProcessIdentity) {
        for (const goal of this.data.goals.filter((entry) => entry.session_id === session.id)) {
          if (String(goal.session_key || '').startsWith('process-')) goal.session_key = item.session_key;
          if (String(goal.resume_id || '').startsWith('process-')) goal.resume_id = item.session_key;
        }
      }
      Object.assign(session, item, { session_key: preservedKey, runtime_session_key: item.session_key, registered: Boolean(session.registered), running: true });
      seen.add(session.id);
    }
    for (const session of this.data.sessions) if (session.runtime_key && !seen.has(session.id)) session.running = false;
    for (const session of this.data.sessions) {
      session.parent_session_id = session.parent_session_key ? this.data.sessions.find((item) => item.session_key === session.parent_session_key || item.runtime_session_key === session.parent_session_key)?.id || null : null;
    }
    this.persist(); return this.sessions();
  }
  sessions({ includeEnded = false } = {}) {
    return this.data.sessions.map((session) => {
      const goals = this.data.goals.filter((goal) => goal.session_id === session.id || (!goal.session_id && goal.agent === session.provider && goal.session_key === session.session_key));
      const activeGoal = [...goals].filter((goal) => !goal.archived_at && !goal.completed_at).sort((a,b) => b.started_at.localeCompare(a.started_at))[0] || null;
      const latestGoal = [...goals].filter((goal) => !goal.archived_at).sort((a,b) => b.started_at.localeCompare(a.started_at))[0] || null;
      const displayGoal = activeGoal || latestGoal;
      const reports = displayGoal ? this.data.reports.filter((item) => item.goal_id === displayGoal.id).sort((a,b) => a.created_at.localeCompare(b.created_at)) : [];
      const latestReport = reports.at(-1);
      return {
        ...clone(session),
        goals: goals.map((goal) => goal.id),
        goal_count: goals.length,
        active_goal: activeGoal ? clone(activeGoal) : null,
        latest_goal: latestGoal ? clone(latestGoal) : null,
        active_status: displayGoal ? this.deriveStatus(displayGoal, reports) : null,
        latest_report: latestReport ? this.getReport(latestReport.id) : null,
        resources: displayGoal ? this.resourceSummary(displayGoal.id) : { latest: [], aggregates: [], history: [] },
      };
    }).filter((session) => includeEnded || session.running === true || session.active_goal).sort((a,b) => Number(b.starred) - Number(a.starred) || (a.role === 'MAIN' ? -1 : 1) || String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
  }
  getSession(id) {
    const session = this.data.sessions.find((item) => item.id === id); if (!session) return null;
    const goals = this.data.goals.filter((goal) => goal.session_id === id || (!goal.session_id && goal.agent === session.provider && goal.session_key === session.session_key)).sort((a,b) => a.started_at.localeCompare(b.started_at));
    return { session: clone(session), goals: goals.map((goal) => this.getGoal(goal.id)) };
  }
  setSessionStar(id, starred) {
    const session = this.data.sessions.find((item) => item.id === id); if (!session) throw new Error('Session not found');
    if (!session.supervised && starred) throw new Error('Supervise the session before starring it');
    session.starred = Boolean(starred); this.persist(); return clone(session);
  }
  setSessionSupervised(id, supervised) {
    const session = this.data.sessions.find((item) => item.id === id); if (!session) throw new Error('Session not found');
    session.supervised = Boolean(supervised); if (!session.supervised) session.starred = false;
    this.persist(); return clone(session);
  }
  setSessionSettings(id, input = {}) {
    const session = this.data.sessions.find((item) => item.id === id); if (!session) throw new Error('Session not found');
    if (input.artifactLanguage !== undefined) {
      if (!ARTIFACT_LANGUAGES.has(input.artifactLanguage)) throw new Error('Unsupported artifact language');
      session.artifact_language = input.artifactLanguage;
    }
    if (input.model !== undefined) {
      if (input.model !== null && (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]=,/-]{0,159}$/.test(input.model))) throw new Error('Invalid model');
      session.model = input.model || null;
    }
    this.persist(); return clone(session);
  }
  identifySession(input) {
    const provider = required(input.provider, 'provider'); const sessionKey = required(input.sessionKey, 'sessionKey');
    const session = this.upsertRegisteredSession({ ...input, workingDirectory: input.workingDirectory }, provider, sessionKey);
    this.persist(); return clone(session);
  }
  addReport(goalId, input) {
    const goal = this.data.goals.find((item) => item.id === goalId); if (!goal) throw new Error('Goal not found');
    if (!this.data.sessions.find((item) => item.id === goal.session_id)?.supervised) throw new Error('Session is not supervised');
    const type = String(input.type || 'UPDATE').toUpperCase();
    if (!REPORT_TYPES.has(type)) throw new Error('type must be UPDATE, REQUEST, or FINAL');
    if (type !== 'REQUEST' && input.blocking) throw new Error('Only REQUEST reports can be blocking');
    const createdAt = now();
    const report = { id: randomUUID(), goal_id: goalId, type, headline: required(input.headline, 'headline'), bottom_line: required(input.bottomLine, 'bottomLine'), evidence: clone(input.evidence || []), interpretation: input.interpretation || null, next_step: input.nextStep || null, blocking: Boolean(input.blocking), choices: clone(input.choices || []), recommended_choice: input.recommendedChoice || null, created_at: createdAt, seen_at: null, resolved_at: null };
    this.data.reports.push(report); goal.last_agent_at = createdAt; if (type === 'FINAL') goal.completed_at = createdAt;
    for (const attachment of input.attachments || []) this.addAttachment(report.id, attachment, false);
    this.persist(); return this.getReport(report.id);
  }
  addAttachment(reportId, attachment, shouldPersist = true) {
    if (!this.data.reports.some((report) => report.id === reportId)) throw new Error('Report not found');
    const id = randomUUID(); const originalName = basename(required(attachment.name || attachment.path, 'attachment name'));
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || `artifact${extname(originalName)}`;
    const reportDir = join(this.attachmentsDir, reportId); mkdirSync(reportDir, { recursive: true });
    const storedPath = join(reportDir, `${id}-${safeName}`);
    if (attachment.dataBase64) writeFileSync(storedPath, Buffer.from(attachment.dataBase64, 'base64')); else if (attachment.path) copyFileSync(attachment.path, storedPath); else throw new Error('attachment requires path or dataBase64');
    chmodSync(storedPath, 0o600);
    const item = { id, report_id: reportId, filename: safeName, mime_type: attachment.mimeType || null, stored_path: storedPath, size_bytes: statSync(storedPath).size, created_at: now() };
    this.data.attachments.push(item); if (shouldPersist) this.persist(); return clone(item);
  }
  getReport(id) {
    const report = this.data.reports.find((item) => item.id === id); if (!report) return null;
    return { ...clone(report), attachments: this.data.attachments.filter((item) => item.report_id === id).map(({ stored_path, ...item }) => clone(item)), decision: clone(this.data.decisions.filter((item) => item.report_id === id).at(-1) || null) };
  }
  getGoal(id) {
    const goal = this.data.goals.find((item) => item.id === id); if (!goal) return null;
    const reports = this.data.reports.filter((item) => item.goal_id === id).sort((a,b) => a.created_at.localeCompare(b.created_at)).map((report) => this.getReport(report.id));
    const directives = this.data.directives.filter((item) => item.goal_id === id).sort((a,b) => a.created_at.localeCompare(b.created_at)).map(clone);
    return { goal: clone(goal), reports, directives, resources: this.resourceSummary(id), derivedStatus: this.deriveStatus(goal, reports) };
  }
  deriveStatus(goal, reports = null) {
    if (goal.archived_at) return 'ARCHIVED'; if (goal.completed_at) return 'DONE';
    const items = reports || this.data.reports.filter((item) => item.goal_id === goal.id);
    if (items.some((report) => report.type === 'REQUEST' && report.blocking && !report.resolved_at)) return 'NEEDS_YOU';
    if (items.some((report) => !report.seen_at)) return 'REPORT_READY';
    const latest = [...items].sort((a,b) => a.created_at.localeCompare(b.created_at)).at(-1);
    if (Date.now() - Date.parse(latest?.created_at || goal.started_at) > this.staleMinutes * 60_000) return 'STALE';
    return 'WORKING';
  }
  dashboard({ includeArchived = false } = {}) {
    const groups = { NEEDS_YOU: [], REPORT_READY: [], WORKING: [], STALE: [], DONE: [], ARCHIVED: [] };
    const goals = this.data.goals.filter((goal) => {
      if (!includeArchived && goal.archived_at) return false;
      const session = this.data.sessions.find((item) => item.id === goal.session_id);
      return session ? session.supervised : false;
    }).sort((a,b) => b.last_agent_at.localeCompare(a.last_agent_at));
    for (const goal of goals) {
      const reports = this.data.reports.filter((item) => item.goal_id === goal.id).sort((a,b) => a.created_at.localeCompare(b.created_at)); const status = this.deriveStatus(goal, reports); const latest = reports.at(-1);
      groups[status].push({ ...clone(goal), status, latestReport: latest ? this.getReport(latest.id) : null, resources: this.resourceSummary(goal.id) });
    }
    return groups;
  }
  markSeen(reportId) { const report = this.data.reports.find((item) => item.id === reportId); if (!report) throw new Error('Report not found'); report.seen_at ||= now(); this.persist(); return this.getReport(reportId); }
  addDirective(goalId, { body, reportId = null, kind = 'DIRECTIVE' }) {
    const goal = this.data.goals.find((item) => item.id === goalId); if (!goal) throw new Error('Goal not found');
    if (!this.data.sessions.find((item) => item.id === goal.session_id)?.supervised) throw new Error('Session is not supervised');
    const item = { id: randomUUID(), goal_id: goalId, report_id: reportId, kind, body: required(body, 'body'), created_at: now(), delivered_at: null, dispatch_status: 'PENDING', dispatched_at: null, dispatch_error: null };
    this.data.directives.push(item); this.persist(); return clone(item);
  }
  answerRequest(reportId, { choice, comment }) {
    const report = this.data.reports.find((item) => item.id === reportId); if (!report || report.type !== 'REQUEST') throw new Error('Request report not found'); if (report.resolved_at) throw new Error('Request already answered');
    const createdAt = now(); const decision = { id: randomUUID(), report_id: reportId, choice: required(choice, 'choice'), comment: comment || null, created_at: createdAt };
    this.data.decisions.push(decision); report.resolved_at = createdAt; report.seen_at ||= createdAt;
    const directive = { id: randomUUID(), goal_id: report.goal_id, report_id: reportId, kind: 'DECISION', body: `Decision: ${decision.choice}${decision.comment ? `\n\nAdvisor comment: ${decision.comment}` : ''}`, created_at: createdAt, delivered_at: null, dispatch_status: 'PENDING', dispatched_at: null, dispatch_error: null };
    this.data.directives.push(directive); this.persist(); return { ...clone(decision), directive: clone(directive) };
  }
  updateDirectiveDispatch(id, { status, error = null, delivered = false }) {
    const directive = this.data.directives.find((item) => item.id === id); if (!directive) throw new Error('Directive not found');
    directive.dispatch_status = status; directive.dispatch_error = error; directive.dispatched_at = now(); if (delivered) directive.delivered_at = now(); this.persist(); return clone(directive);
  }
  inbox(agent, sessionKey, markDelivered = true) {
    const goal = this.data.goals.find((item) => item.agent === agent && item.session_key === sessionKey && !item.archived_at); if (!goal) return { goal: null, directives: [] };
    const session = this.data.sessions.find((item) => item.id === goal.session_id); if (!session?.supervised) return { goal: null, directives: [], supervised: false };
    const directives = this.data.directives.filter((item) => item.goal_id === goal.id && !item.delivered_at && !['RUNNING','SENT'].includes(item.dispatch_status)).sort((a,b) => a.created_at.localeCompare(b.created_at));
    if (markDelivered && directives.length) { const at = now(); for (const item of directives) { item.delivered_at = at; item.dispatch_status = 'HOOK_DELIVERED'; item.dispatched_at ||= at; } this.persist(); }
    return { goal: clone(goal), directives: directives.map(clone), supervised: true };
  }
  archiveGoal(id) { const goal = this.data.goals.find((item) => item.id === id); if (!goal) throw new Error('Goal not found'); goal.archived_at = now(); this.persist(); }
  addResourceSample(goalId, sample) {
    const goal = this.data.goals.find((item) => item.id === goalId); if (!goal) throw new Error('Goal not found');
    const session = this.data.sessions.find((item) => item.id === goal.session_id); if (!session?.supervised) return null;
    const item = { id: ++this.data.resourceCounter, goal_id: goalId, host: required(sample.host, 'host'), scope: sample.scope === 'remote' ? 'remote' : 'local', cpu_percent: Number(sample.cpuPercent || 0), rss_bytes: Number(sample.rssBytes || 0), gpu_memory_bytes: Number(sample.gpuMemoryBytes || 0), process_count: Number(sample.processCount || 0), sampled_at: sample.sampledAt || now() };
    this.data.resources.push(item); const own = this.data.resources.filter((entry) => entry.goal_id === goalId).sort((a,b) => b.sampled_at.localeCompare(a.sampled_at)); const keep = new Set(own.slice(0, 2000).map((entry) => entry.id)); this.data.resources = this.data.resources.filter((entry) => entry.goal_id !== goalId || keep.has(entry.id));
    this.persist(); return clone(item);
  }
  resourceSummary(goalId) {
    const rows = this.data.resources.filter((item) => item.goal_id === goalId).sort((a,b) => a.sampled_at.localeCompare(b.sampled_at)); const latestByHost = new Map(); for (const row of rows) latestByHost.set(row.host, row); const cutoff = Date.now() - 86_400_000;
    const aggregates = [];
    for (const host of latestByHost.keys()) {
      const hostRows = rows.filter((item) => item.host === host); let cpuCoreSeconds = 0;
      for (let index = 1; index < hostRows.length; index += 1) {
        const seconds = Math.min(300, Math.max(0, (Date.parse(hostRows[index].sampled_at) - Date.parse(hostRows[index - 1].sampled_at)) / 1000));
        cpuCoreSeconds += seconds * hostRows[index - 1].cpu_percent / 100;
      }
      aggregates.push({ host, scope: hostRows[0].scope, peak_rss_bytes: Math.max(...hostRows.map((item) => item.rss_bytes)), peak_gpu_memory_bytes: Math.max(...hostRows.map((item) => item.gpu_memory_bytes || 0)), avg_cpu_percent: hostRows.reduce((sum, item) => sum + item.cpu_percent, 0) / hostRows.length, cpu_core_seconds: cpuCoreSeconds, samples: hostRows.length });
    }
    return { latest: [...latestByHost.values()].sort((a,b) => a.scope.localeCompare(b.scope) || a.host.localeCompare(b.host)).map(clone), aggregates, history: rows.filter((item) => Date.parse(item.sampled_at) >= cutoff).map(({ id, goal_id, ...item }) => clone(item)) };
  }
  attachment(id) { return clone(this.data.attachments.find((item) => item.id === id) || null); }
  stats() { const dashboard = this.dashboard(); return { goals: this.data.goals.filter((goal) => !goal.archived_at).length, needsYou: dashboard.NEEDS_YOU.length, unreadReports: this.data.reports.filter((report) => !report.seen_at).length }; }
}
