const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const fmtBytes = (bytes = 0) => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
const ago = (date) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(date)) / 60000));
  if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes} min`; if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} m`; return `${Math.floor(minutes / 1440)} d`;
};
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong'); return data;
};
function toast(message) { toastEl.textContent = message; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 2200); }

function resourceChips(goal) {
  const latest = goal.resources?.latest || [];
  if (!latest.length) return '<span class="resource-chip">awaiting sample</span>';
  return latest.map((r) => `<span class="resource-chip ${r.scope}">${r.scope === 'remote' ? '↗' : '⌁'} ${esc(r.host)} · ${fmtBytes(r.rss_bytes)}</span>`).join('');
}

const providerCode = (provider = '') => provider.startsWith('Claude') ? 'CL' : provider.startsWith('Cursor') ? 'CU' : provider === 'Codex' ? 'CX' : provider === 'Agy' ? 'AG' : 'AI';
const projectName = (session) => {
  const goal = session.active_goal || session.latest_goal;
  const path = goal?.repository || session.working_directory || 'Unassigned workspace';
  return String(path).split('/').filter(Boolean).at(-1) || path;
};
const shortSession = (session) => session.identity_authoritative ? String(session.session_key).slice(0, 10) : `pid ${session.pid}`;
const statusRank = { NEEDS_YOU: 0, REPORT_READY: 1, STALE: 2, WORKING: 3, DONE: 4 };
const statusLabel = { NEEDS_YOU: 'Needs you', REPORT_READY: 'Report ready', STALE: 'Stale', WORKING: 'Working', DONE: 'Done' };
const artifactLanguages = { 'zh-CN':'简体中文', 'zh-TW':'繁體中文', en:'English', ja:'日本語', ko:'한국어' };
const orderSessions = (sessions) => [...sessions].sort((a, b) => (statusRank[a.active_status] ?? 9) - (statusRank[b.active_status] ?? 9) || Number(b.starred) - Number(a.starred) || String(b.last_seen_at).localeCompare(String(a.last_seen_at)));

function sessionCard(session, compact = false) {
  const isSubagent = session.role === 'SUBAGENT';
  const runtimeState = session.running === true ? 'running' : session.running === false ? 'ended' : 'registered';
  const runtimeLabel = session.running === true && session.provider_status ? `running · ${session.provider_status}` : runtimeState;
  const modelLabel = session.effective_model || 'provider default';
  const goal = session.active_goal || session.latest_goal;
  const status = session.active_status;
  const summary = session.latest_report?.bottom_line || goal?.original_goal || session.working_directory || 'Detected process; waiting for the agent to register a goal.';
  const latest = session.latest_report;
  const progressPreview = latest ? `<div class="progress-preview"><div class="progress-preview-head"><span>${esc(latest.type === 'FINAL' ? 'Final result' : 'Latest progress')}</span><time>${ago(latest.created_at)} ago</time></div><strong>${esc(latest.headline)}</strong><p>${esc(latest.bottom_line)}</p>${latest.next_step ? `<small><b>Next</b> ${esc(latest.next_step)}</small>` : ''}</div>` : `<p class="session-goal-summary">${esc(summary)}</p>`;
  return `<article class="session-card ${session.starred ? 'core' : ''} ${isSubagent ? 'subagent' : ''} ${compact ? 'compact' : ''} ${status ? `status-${status.toLowerCase().replaceAll('_', '-')}` : ''}" data-open-session="${session.id}">
    ${session.supervised ? `<button class="star-button ${session.starred ? 'active' : ''}" data-star-session="${session.id}" data-starred="${session.starred ? '1' : '0'}" aria-label="${session.starred ? 'Remove from core sessions' : 'Add to core sessions'}" title="${session.starred ? 'Core session' : 'Star as core session'}">${session.starred ? '★' : '☆'}</button>` : ''}
    <div class="session-provider ${esc(session.provider.toLowerCase().replaceAll(' ', '-'))}">${providerCode(session.provider)}</div>
    <div class="session-copy"><div class="session-kicker">${esc(session.provider)} <span class="role-badge ${isSubagent ? 'sub' : ''}">${isSubagent ? '↳ SUBAGENT' : 'MAIN'}</span><span class="runtime-state ${runtimeState}"><span class="state-dot ${runtimeState}"></span>${esc(runtimeLabel)}</span><span class="model-badge" title="${session.model_source === 'advisor' ? 'Selected in iamyourboss' : 'Provider default'}">◇ ${esc(modelLabel)}</span></div>
      <h3>${esc(goal?.title || projectName(session))}</h3>
      ${status ? `<span class="session-status ${status.toLowerCase().replaceAll('_', '-')}">${esc(statusLabel[status] || status)}</span>` : ''}
      ${progressPreview}
    </div>
    <div class="session-footer"><div class="session-facts"><span>${esc(shortSession(session))}</span><span>${session.tty ? esc(session.tty) : 'no tty'}</span><span>${ago(session.started_at)} runtime</span>${session.last_seen_at ? `<span>seen ${ago(session.last_seen_at)} ago</span>` : ''}</div>${session.supervised ? `<div class="session-footer-actions"><div class="resources">${resourceChips(session)}</div>${goal ? `<button class="btn small artifact-request" data-session-report="${goal.id}">Collect progress &amp; TODO</button>` : '<button class="btn small" disabled>Preparing progress…</button>'}<button class="btn small stop-supervising" data-stop-supervising="${session.id}">Stop</button></div>` : ''}</div>
  </article>`;
}

function candidateRow(session) {
  return `<div class="candidate-row"><div class="session-provider ${esc(session.provider.toLowerCase().replaceAll(' ', '-'))}">${providerCode(session.provider)}</div><div><strong>${esc(projectName(session))}</strong><span>${esc(session.provider)} · ${session.role === 'SUBAGENT' ? 'subagent' : 'main'} · ${ago(session.started_at)} runtime</span></div><code>${esc(session.tty || `pid ${session.pid}`)}</code><button class="btn supervise" data-supervise-session="${session.id}" data-supervised="0">＋ Supervise</button></div>`;
}

function reportCard(goal, urgent = false) {
  const report = goal.latestReport;
  return `<article class="goal-card ${urgent ? 'urgent' : 'report-ready'}">
    <div class="card-top"><div><div class="repo">${esc(goal.repository || goal.working_directory || 'unassigned repository')}</div><h3 class="goal-title">${esc(goal.title)}</h3></div><span class="agent-pill">${esc(goal.agent)}</span></div>
    <div class="report-label">${urgent ? '⚠ decision needed' : `● ${esc(report?.type === 'FINAL' ? 'final report' : 'important result')}`}</div>
    <p class="bottom-line">${esc(report?.bottom_line || goal.original_goal)}</p>
    <div class="resources">${resourceChips(goal)}</div>
    <div class="card-footer"><span class="meta">${ago(report?.created_at || goal.started_at)} ago${report?.id ? ` · record ${esc(report.id.slice(0, 8))}` : ''} · session ${esc(goal.session_key.slice(0, 7))}</span><div class="actions"><button class="btn ${urgent ? 'coral' : 'primary'}" data-open="${goal.id}">${urgent ? 'Review request' : 'Read report'}</button></div></div>
  </article>`;
}

function workingRow(goal, stale = false) {
  return `<div class="working-row ${stale ? 'stale-row' : ''}"><div><div class="working-title">${esc(goal.title)}</div><div class="repo">${esc(goal.repository || goal.working_directory || '')}</div></div><div class="resources">${resourceChips(goal)}</div><span class="agent-pill">${esc(goal.agent)}</span><span class="age">${ago(goal.last_agent_at || goal.started_at)}</span>${stale ? `<button class="btn small" data-request-report="${goal.id}">Request report</button>` : `<button class="btn small" data-open="${goal.id}">Open</button>`}</div>`;
}

function section(title, goals, content, hint = '') {
  if (!goals.length) return '';
  return `<section class="section"><div class="section-head"><h2 class="section-title">${esc(title)} <span class="count">${goals.length}</span></h2><span class="section-hint">${esc(hint)}</span></div>${content}</section>`;
}

function renderDashboard(data) {
  const total = ['NEEDS_YOU','REPORT_READY','WORKING','STALE','DONE'].reduce((sum, key) => sum + data[key].length, 0);
  const sessions = data.sessions || [];
  if (!total && !sessions.length) {
    app.innerHTML = `<div class="empty-state"><div class="empty-inner"><div class="empty-orbit"><span>iyb</span></div><p class="eyebrow">Advisor desk is ready</p><h1>Your students will appear here automatically.</h1><p>Keep using your coding agents normally. When a session begins a substantive goal, its student card and research record will arrive here.</p><div class="connected"><span>✓ Claude Code</span><span>✓ Codex</span><span>✓ Agy</span><span>✓ Cursor Agent</span><span>local server · :7331</span></div></div></div>`;
    return;
  }
  const supervised = sessions.filter((session) => session.supervised);
  const candidates = sessions.filter((session) => !session.supervised);
  const core = supervised.filter((session) => session.starred);
  const other = supervised.filter((session) => !session.starred);
  const mainCount = supervised.filter((session) => session.role !== 'SUBAGENT').length;
  const subCount = supervised.length - mainCount;
  const supervisedIds = new Set(supervised.map((session) => session.id));
  const unlinked = Object.fromEntries(['NEEDS_YOU','REPORT_READY','WORKING','STALE','DONE'].map((key) => [key, data[key].filter((goal) => !goal.session_id || !supervisedIds.has(goal.session_id))]));
  const needYouCount = supervised.filter((session) => session.active_status === 'NEEDS_YOU').length + unlinked.NEEDS_YOU.length;
  const reportCount = supervised.filter((session) => session.active_status === 'REPORT_READY').length + unlinked.REPORT_READY.length;
  app.innerHTML = `<div class="shell"><section class="hero"><div><p class="eyebrow">Advisor desk · ${new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })}</p><h1>Your autonomous lab, at a glance.</h1><p class="hero-note">One card per supervised student. Goal status, reports, and hardware usage stay attached to that session.</p></div><div class="stat-row"><div class="stat attention"><strong>${needYouCount}</strong><span>need you</span></div><div class="stat"><strong>${mainCount}</strong><span>main agents</span></div><div class="stat"><strong>${subCount}</strong><span>subagents</span></div><div class="stat"><strong>${reportCount}</strong><span>new reports</span></div></div></section>
    ${core.length ? `<section class="session-section core-section"><div class="section-head"><h2 class="section-title">Core sessions <span class="count">${core.length}</span></h2><span class="section-hint">starred for close supervision</span></div><div class="session-list">${orderSessions(core).map((session) => sessionCard(session, true)).join('')}</div></section>` : ''}
    ${other.length ? `<section class="session-section"><div class="section-head"><h2 class="section-title">Supervised sessions <span class="count">${other.length}</span></h2><span class="section-hint">${mainCount} main · ${subCount} subagent${subCount === 1 ? '' : 's'}</span></div><div class="session-list">${orderSessions(other).map((session) => sessionCard(session)).join('')}</div></section>` : ''}
    ${section('Unlinked requests', unlinked.NEEDS_YOU, `<div class="card-grid">${unlinked.NEEDS_YOU.map((g) => reportCard(g, true)).join('')}</div>`, 'legacy goals not yet matched to a session')}
    ${section('Unlinked reports', unlinked.REPORT_READY, `<div class="card-grid">${unlinked.REPORT_READY.map((g) => reportCard(g)).join('')}</div>`, 'legacy goals not yet matched to a session')}
    ${section('Unlinked goals', [...unlinked.WORKING, ...unlinked.STALE, ...unlinked.DONE], `<div class="working-list">${[...unlinked.WORKING, ...unlinked.STALE, ...unlinked.DONE].map((g) => workingRow(g, g.status === 'STALE')).join('')}</div>`, 'legacy records awaiting session identity')}
    ${candidates.length ? `<section class="candidate-section"><div class="section-head"><h2 class="section-title">Discovered nearby <span class="count soft">${candidates.length}</span></h2><span class="section-hint">dormant until you choose to supervise</span></div><div class="candidate-list">${candidates.map(candidateRow).join('')}</div></section>` : ''}
    </div>`;
}

function evidenceHtml(evidence = []) {
  if (!evidence.length) return '';
  return `<h3>Evidence</h3><div class="evidence">${evidence.map((item) => `<div class="evidence-row">${esc(typeof item === 'string' ? item : Object.entries(item).map(([k,v]) => `${k}: ${v}`).join(' · '))}</div>`).join('')}</div>`;
}

function attachmentHtml(items = []) {
  if (!items.length) return '';
  return `<div class="attachments">${items.map((item) => {
    const isHtml = item.mime_type === 'text/html' || item.filename?.toLowerCase().endsWith('.html');
    if (isHtml) return `<div class="attachment html-artifact"><iframe class="artifact-frame" src="/api/attachments/${item.id}" sandbox="allow-scripts" loading="lazy" title="${esc(item.filename)}"></iframe><span><a href="/api/attachments/${item.id}" target="_blank">↗ ${esc(item.filename)}</a> · ${fmtBytes(item.size_bytes)}</span></div>`;
    return `<a class="attachment" href="/api/attachments/${item.id}" target="_blank">${item.mime_type?.startsWith('image/') ? `<img src="/api/attachments/${item.id}" alt="${esc(item.filename)}">` : ''}<span>↗ ${esc(item.filename)} · ${fmtBytes(item.size_bytes)}</span></a>`;
  }).join('')}</div>`;
}

function reportSheet(report) {
  const choices = report.type === 'REQUEST' && !report.resolved_at ? `<div class="ask"><strong>Advisor decision</strong><div class="choice-row">${(report.choices.length ? report.choices : ['Approve','Reject']).map((choice) => `<button class="choice ${choice === report.recommended_choice ? 'recommended' : ''}" data-decision="${report.id}" data-choice="${esc(choice)}">${esc(choice)}</button>`).join('')}<button class="choice" data-decision-other="${report.id}">Other / comment</button></div></div>` : '';
  return `<div class="report-sheet"><h2>${esc(report.headline)}</h2><h3>Bottom line</h3><p>${esc(report.bottom_line)}</p>${evidenceHtml(report.evidence)}${attachmentHtml(report.attachments)}${report.interpretation ? `<h3>Interpretation</h3><p>${esc(report.interpretation)}</p>` : ''}${report.next_step ? `<h3>${report.type === 'FINAL' ? 'Outcome' : 'Recommendation / next'}</h3><p>${esc(report.next_step)}</p>` : ''}${choices}${report.decision ? `<div class="decision">✓ Advisor chose ${esc(report.decision.choice)}${report.decision.comment ? ` — ${esc(report.decision.comment)}` : ''}</div>` : ''}</div>`;
}

function reportHtml(report) {
  return `<article class="timeline-item ${report.type.toLowerCase()}"><span class="timeline-dot"></span><div class="timeline-meta">${esc(report.type)} · ${new Date(report.created_at).toLocaleString()} · record ${esc(report.id.slice(0, 8))}</div>${reportSheet(report)}</article>`;
}

function directiveHtml(item) {
  const status = item.dispatch_status || (item.delivered_at ? 'HOOK_DELIVERED' : 'PENDING');
  const label = ({ PENDING:'queued', RUNNING:'sending prompt…', SENT:'prompt delivered', FAILED:'prompt failed · hook fallback', HOOK_PENDING:'waiting for next agent turn', HOOK_DELIVERED:'delivered by hook' })[status] || status.toLowerCase();
  return `<article class="timeline-item directive"><span class="timeline-dot"></span><div class="timeline-meta">You · ${new Date(item.created_at).toLocaleString()} · ${esc(item.kind.replace('_',' '))}</div><div class="directive-note">${esc(item.body)}<div class="delivery ${status === 'FAILED' ? 'failed' : ''}">${status === 'SENT' || status === 'HOOK_DELIVERED' ? '✓' : status === 'FAILED' ? '!' : '↗'} ${esc(label)}${item.dispatch_error && status === 'FAILED' ? ` · ${esc(item.dispatch_error)}` : ''}</div></div></article>`;
}

function timeline(reports, directives) {
  return [...reports.map((item) => ({ ...item, entry:'report' })), ...directives.map((item) => ({ ...item, entry:'directive' }))].sort((a,b) => a.created_at.localeCompare(b.created_at)).map((item) => item.entry === 'report' ? reportHtml(item) : directiveHtml(item)).join('') || '<p class="muted">The student is working. No advisor-worthy report yet.</p>';
}

function sessionInteractions(goals) {
  const entries = goals.flatMap((record) => [
    ...record.reports.map((item) => ({ ...item, entry: 'report', goalTitle: record.goal.title })),
    ...record.directives.map((item) => ({ ...item, entry: 'directive', goalTitle: record.goal.title })),
  ]).sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!entries.length) return '<div class="empty-session"><strong>No reports yet.</strong><p>Use Collect progress &amp; TODO when you want the student to stop at a sensible point and synthesize.</p></div>';
  return `<div class="interaction-stack">${entries.map((item, index) => {
    const isReport = item.entry === 'report';
    const status = item.dispatch_status || (item.delivered_at ? 'HOOK_DELIVERED' : 'PENDING');
    const deliveryLabel = ({ PENDING:'queued', RUNNING:'sending', SENT:'delivered', FAILED:'failed', HOOK_PENDING:'waiting for agent', HOOK_DELIVERED:'delivered' })[status] || status.toLowerCase();
    const title = isReport ? item.headline : item.kind === 'REPORT_REQUEST' ? 'Progress & TODO requested' : item.kind === 'DECISION' ? 'Decision sent' : 'Advisor prompt';
    const kind = isReport ? item.type : 'YOU';
    const record = isReport ? `record ${item.id.slice(0, 8)}` : deliveryLabel;
    const body = isReport ? reportSheet(item) : `<div class="directive-note">${esc(item.body)}<div class="delivery ${status === 'FAILED' ? 'failed' : ''}">${status === 'SENT' || status === 'HOOK_DELIVERED' ? '✓' : status === 'FAILED' ? '!' : '↗'} ${esc(deliveryLabel)}</div></div>`;
    return `<details class="interaction-block ${isReport ? item.type.toLowerCase() : 'directive'}" ${index === 0 ? 'open' : ''}><summary><span class="interaction-kind">${esc(kind)}</span><span class="interaction-summary"><strong>${esc(title)}</strong><small>${new Date(item.created_at).toLocaleString()} · ${esc(record)} · ${esc(item.goalTitle)}</small></span><span class="interaction-chevron">⌄</span></summary><div class="interaction-content">${body}</div></details>`;
  }).join('')}</div>`;
}

function sparkline(rows, host) {
  const points = rows.filter((r) => r.host === host).slice(-30);
  if (points.length < 2) return '';
  const max = Math.max(...points.map((p) => p.rss_bytes), 1);
  const d = points.map((p, i) => `${i ? 'L' : 'M'} ${(i/(points.length-1))*280} ${36-(p.rss_bytes/max)*32}`).join(' ');
  return `<svg class="spark" viewBox="0 0 280 38" preserveAspectRatio="none" aria-label="24 hour memory trend"><path d="${d}" fill="none" stroke="${points[0].scope === 'remote' ? '#315ec9' : '#164f3c'}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function resourcePanel(resources) {
  if (!resources.latest.length) return '<p class="muted">Waiting for the first session sample.</p>';
  return resources.latest.map((r) => { const total = resources.aggregates?.find((item) => item.host === r.host); return `<div class="resource-card"><div class="resource-name"><span>${r.scope === 'remote' ? 'REMOTE ↗' : 'LOCAL ⌁'}</span><span>${esc(r.host)}</span></div><div class="resource-number">${fmtBytes(r.rss_bytes)}</div><div class="resource-sub">${r.cpu_percent.toFixed(1)}% CPU · ${r.process_count} session processes${r.gpu_memory_bytes ? `<br>${fmtBytes(r.gpu_memory_bytes)} GPU memory` : ''}${total ? `<br>peak ${fmtBytes(total.peak_rss_bytes)} RAM${total.peak_gpu_memory_bytes ? ` / ${fmtBytes(total.peak_gpu_memory_bytes)} GPU` : ''} · ${(total.cpu_core_seconds / 3600).toFixed(2)} core-hours` : ''}</div>${sparkline(resources.history, r.host)}</div>`; }).join('');
}

async function renderSession(id) {
  const data = await api(`/api/sessions/${id}`);
  const { session, goals } = data;
  const catalog = await api(`/api/models?provider=${encodeURIComponent(session.provider)}`);
  const active = [...goals].reverse().find((item) => !item.goal.archived_at && !item.goal.completed_at) || goals.at(-1);
  const interactions = sessionInteractions(goals);
  const state = session.running === true ? `RUNNING${session.provider_status ? ` · ${session.provider_status.toUpperCase()}` : ''}` : session.running === false ? 'ENDED' : 'REGISTERED';
  app.innerHTML = `<div class="shell notebook session-notebook"><a class="back" href="#">← Advisor overview</a><header class="notebook-head session-titlebar"><div><p class="eyebrow">${esc(session.provider)} · ${session.role === 'SUBAGENT' ? 'Subagent' : 'Main agent'}</p><h1>${esc(active?.goal.title || projectName({ ...session, active_goal: null }))}</h1><p class="meta">${esc(session.working_directory || 'Workspace not reported')} · ${esc(shortSession(session))} · PID ${session.pid || '—'} · ${ago(session.started_at || session.first_seen_at)} runtime</p></div><div class="title-actions">${session.supervised ? `<button class="star-button large ${session.starred ? 'active' : ''}" data-star-session="${session.id}" data-starred="${session.starred ? '1' : '0'}">${session.starred ? '★ Core' : '☆ Star'}</button>` : ''}<button class="btn ${session.supervised ? '' : 'primary'}" data-supervise-session="${session.id}" data-supervised="${session.supervised ? '1' : '0'}">${session.supervised ? 'Stop supervising' : '＋ Supervise'}</button><span class="status-stamp"><span class="state-dot ${session.running === true ? 'running' : session.running === false ? 'ended' : 'registered'}"></span>${esc(state)}</span></div></header><div class="notebook-grid"><section class="session-history"><div class="feed-head"><h2>Interactions</h2><span>${goals.reduce((sum, item) => sum + item.reports.length + item.directives.length, 0)} records</span></div>${interactions}</section><aside class="sidebar">${active && session.supervised ? `<section class="panel collect-panel"><div class="session-setting"><label for="session-model">Model</label><div class="model-control"><input id="session-model" list="session-model-options" value="${esc(session.model || '')}" placeholder="${esc(catalog.defaultModel || 'provider default')}"><datalist id="session-model-options">${catalog.models.map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('')}</datalist><button class="btn small" id="save-session-model">Apply</button></div><small>${session.model ? 'Advisor override for future dispatched turns.' : `Using provider default${catalog.defaultModel ? `: ${esc(catalog.defaultModel)}` : ''}.`}</small></div><div class="artifact-language"><label for="artifact-language">Artifact language</label><select id="artifact-language">${Object.entries(artifactLanguages).map(([value, label]) => `<option value="${value}" ${value === (session.artifact_language || 'zh-CN') ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div><button class="btn primary collect-button" id="session-request-report">Collect progress &amp; TODO</button><p class="resource-sub">Prompts this student to return one concise HTML table or figure in ${esc(artifactLanguages[session.artifact_language] || '简体中文')}. No logs or transcript.</p><details class="prompt-composer"><summary>Send a different prompt</summary><form class="form" id="session-directive-form"><textarea name="body" placeholder="Give this student a new direction…" required></textarea><button class="btn" type="submit">Send prompt</button></form></details></section><section class="panel live-hardware"><h3><span class="state-dot running"></span> Session resources</h3>${resourcePanel(active.resources)}<p class="resource-sub">10-second process-tree samples only.</p></section>` : `<section class="panel"><h3>${session.supervised ? 'Waiting for registration' : 'Not supervised'}</h3><p class="resource-sub">${session.supervised ? 'Prompting becomes available after the agent registers a goal.' : 'No prompts or resource sampling run for this session.'}</p></section>`}</aside></div></div>`;
  if (active && session.supervised) {
    document.querySelector('#save-session-model').addEventListener('click', async () => { const value = document.querySelector('#session-model').value.trim(); await api(`/api/sessions/${session.id}/settings`, { method:'POST', body:{ model: value || null } }); toast(value ? `Model set: ${value}` : 'Using provider default model'); await renderSession(id); });
    document.querySelector('#artifact-language').addEventListener('change', async (event) => { await api(`/api/sessions/${session.id}/settings`, { method:'POST', body:{ artifactLanguage: event.target.value } }); toast(`Artifact language: ${artifactLanguages[event.target.value]}`); await renderSession(id); });
    document.querySelector('#session-directive-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); await api(`/api/goals/${active.goal.id}/directives`, { method:'POST', body:{ body: form.get('body') } }); toast('Prompt sent to session'); await renderSession(id); });
    document.querySelector('#session-request-report').addEventListener('click', async () => { await api(`/api/goals/${active.goal.id}/request-report`, { method:'POST' }); toast('Progress & TODO requested'); await renderSession(id); });
  }
  const unread = goals.flatMap((item) => item.reports).filter((report) => !report.seen_at);
  await Promise.all(unread.map((report) => api(`/api/reports/${report.id}/seen`, { method:'POST' })));
}

async function renderGoal(id) {
  const data = await api(`/api/goals/${id}`);
  const { goal, reports, directives, resources, derivedStatus } = data;
  app.innerHTML = `<div class="shell notebook"><a class="back" href="#">← Advisor overview</a><header class="notebook-head"><div><p class="eyebrow">${esc(goal.repository || goal.working_directory || 'Goal')}</p><h1>${esc(goal.title)}</h1><p class="goal-copy">${esc(goal.original_goal)}</p><p class="meta">${esc(goal.agent)} · session ${esc(goal.session_key)} · started ${new Date(goal.started_at).toLocaleString()}</p></div><span class="status-stamp">${esc(derivedStatus.replace('_',' '))}</span></header><div class="notebook-grid"><section class="timeline">${timeline(reports, directives)}</section><aside class="sidebar"><section class="panel"><h3>Session resources</h3>${resourcePanel(resources)}<p class="resource-sub">Process-tree totals only. Commands and terminal content are never collected.</p></section><section class="panel"><h3>Send prompt</h3><form class="form" id="directive-form"><textarea name="body" placeholder="What should the student reconsider or do next?" required></textarea><button class="btn primary" type="submit">Send new agent turn</button></form><p class="resource-sub">Resumes this exact coding-agent session. No transcript is imported.</p></section><section class="panel"><button class="btn" id="request-report">Request report</button><p class="resource-sub">The student will stop at a sensible point and synthesize.</p></section><button class="danger-link" id="archive-goal">Archive goal</button></aside></div></div>`;
  for (const report of reports.filter((r) => !r.seen_at)) await api(`/api/reports/${report.id}/seen`, { method:'POST' });
  document.querySelector('#directive-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); await api(`/api/goals/${id}/directives`, { method:'POST', body:{ body: form.get('body') } }); toast('Directive sent'); await renderGoal(id); });
  document.querySelector('#request-report').addEventListener('click', async () => { await api(`/api/goals/${id}/request-report`, { method:'POST' }); toast('Report requested'); await renderGoal(id); });
  document.querySelector('#archive-goal').addEventListener('click', async () => { if (!confirm('Archive this goal? Its research record stays on disk.')) return; await api(`/api/goals/${id}/archive`, { method:'POST' }); location.hash = ''; });
}

async function decide(reportId, choice) {
  let comment = '';
  if (choice == null) { choice = prompt('Your decision'); if (!choice) return; comment = prompt('Optional context for the student') || ''; }
  else comment = prompt('Optional context for the student') || '';
  await api(`/api/reports/${reportId}/decision`, { method:'POST', body:{ choice, comment } }); toast('Decision sent'); route();
}

async function route() {
  try {
    const goalMatch = location.hash.match(/^#goal\/([^/]+)$/);
    const sessionMatch = location.hash.match(/^#session\/([^/]+)$/);
    if (goalMatch) await renderGoal(goalMatch[1]); else if (sessionMatch) await renderSession(sessionMatch[1]); else renderDashboard(await api('/api/dashboard'));
  } catch (error) { app.innerHTML = `<div class="loading">${esc(error.message)}</div>`; }
}

document.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open]'); if (open) location.hash = `goal/${open.dataset.open}`;
  const openSession = event.target.closest('[data-open-session]'); if (openSession && !event.target.closest('[data-star-session]') && !event.target.closest('[data-session-report]') && !event.target.closest('[data-stop-supervising]')) location.hash = `session/${openSession.dataset.openSession}`;
  const star = event.target.closest('[data-star-session]'); if (star) { event.stopPropagation(); await api(`/api/sessions/${star.dataset.starSession}/star`, { method:'POST', body:{ starred: star.dataset.starred !== '1' } }); toast(star.dataset.starred === '1' ? 'Removed from core sessions' : 'Added to core sessions'); route(); }
  const sessionReport = event.target.closest('[data-session-report]'); if (sessionReport) { event.stopPropagation(); await api(`/api/goals/${sessionReport.dataset.sessionReport}/request-report`, { method:'POST' }); toast('Progress & TODO requested'); route(); }
  const stopSupervising = event.target.closest('[data-stop-supervising]'); if (stopSupervising) { event.stopPropagation(); await api(`/api/sessions/${stopSupervising.dataset.stopSupervising}/supervise`, { method:'POST', body:{ supervised: false } }); toast('Supervision stopped; research record preserved'); route(); }
  const supervise = event.target.closest('[data-supervise-session]'); if (supervise) { event.stopPropagation(); const enabling = supervise.dataset.supervised !== '1'; await api(`/api/sessions/${supervise.dataset.superviseSession}/supervise`, { method:'POST', body:{ supervised: enabling } }); toast(enabling ? 'Advisor mode enabled for this session' : 'Advisor mode stopped'); route(); }
  const request = event.target.closest('[data-request-report]'); if (request) { await api(`/api/goals/${request.dataset.requestReport}/request-report`, { method:'POST' }); toast('Report requested'); route(); }
  const choice = event.target.closest('[data-decision]'); if (choice) decide(choice.dataset.decision, choice.dataset.choice);
  const other = event.target.closest('[data-decision-other]'); if (other) decide(other.dataset.decisionOther, null);
});
window.addEventListener('hashchange', route);
new EventSource('/api/events').addEventListener('change', () => { if (!document.querySelector('textarea:focus')) route(); });
setInterval(() => { const el = document.querySelector('#clock'); if (el) el.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }, 1000);
route();
