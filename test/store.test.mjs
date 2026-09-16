import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

function fixture(staleMinutes = 180) {
  const dir = mkdtempSync(join(tmpdir(), 'iyb-store-'));
  return { dir, store: new Store({ dbPath: join(dir, 'record.json'), attachmentsDir: join(dir, 'attachments'), staleMinutes }) };
}

test('advisor workflow has only the intended dashboard state transitions', () => {
  const { store } = fixture();
  const goal = store.createGoal({ title: 'Test retrieval', originalGoal: 'Determine whether retrieval helps.', agent: 'Codex', sessionKey: 'session-1', supervised: true });
  assert.equal(store.dashboard().WORKING[0].id, goal.id);

  const update = store.addReport(goal.id, { type: 'UPDATE', headline: 'Signal found', bottomLine: 'AUROC improves by 0.03.' });
  assert.equal(store.dashboard().REPORT_READY[0].id, goal.id);
  store.markSeen(update.id);
  assert.equal(store.dashboard().WORKING[0].id, goal.id);

  const request = store.addReport(goal.id, { type: 'REQUEST', headline: 'Cache decision', bottomLine: 'Canonical IDs require a migration.', blocking: true, choices: ['Adapter', 'Invalidate'], recommendedChoice: 'Invalidate' });
  assert.equal(store.dashboard().NEEDS_YOU[0].id, goal.id);
  store.answerRequest(request.id, { choice: 'Invalidate', comment: 'Keep a rollback note.' });
  assert.equal(store.dashboard().WORKING[0].id, goal.id);
  const inbox = store.inbox('Codex', 'session-1');
  assert.match(inbox.directives[0].body, /Invalidate/);
  assert.equal(store.inbox('Codex', 'session-1').directives.length, 0);

  store.addReport(goal.id, { type: 'FINAL', headline: 'Goal complete', bottomLine: 'The implementation is verified.' });
  assert.equal(store.dashboard().DONE[0].id, goal.id);
});

test('attachments persist and resource usage separates local and remote hosts', () => {
  const { dir, store } = fixture();
  const goal = store.createGoal({ title: 'Profile run', originalGoal: 'Profile local and remote work.', agent: 'Claude Code', sessionKey: 'session-2', supervised: true });
  const report = store.addReport(goal.id, { type: 'UPDATE', headline: 'Profile ready', bottomLine: 'Remote memory is dominant.', attachments: [{ name: 'plot.csv', mimeType: 'text/csv', dataBase64: Buffer.from('x,y\n1,2\n').toString('base64') }] });
  assert.equal(readFileSync(store.attachment(report.attachments[0].id).stored_path, 'utf8'), 'x,y\n1,2\n');

  store.addResourceSample(goal.id, { host: 'macbook', scope: 'local', cpuPercent: 50, rssBytes: 100, processCount: 2, sampledAt: '2026-09-15T10:00:00.000Z' });
  store.addResourceSample(goal.id, { host: 'macbook', scope: 'local', cpuPercent: 100, rssBytes: 200, processCount: 3, sampledAt: '2026-09-15T10:01:00.000Z' });
  store.addResourceSample(goal.id, { host: 'gpu-1', scope: 'remote', cpuPercent: 200, rssBytes: 900, processCount: 5, sampledAt: '2026-09-15T10:01:00.000Z' });
  const summary = store.resourceSummary(goal.id);
  assert.deepEqual(summary.latest.map((item) => item.scope), ['local', 'remote']);
  assert.equal(summary.aggregates.find((item) => item.host === 'macbook').peak_rss_bytes, 200);
  assert.equal(summary.aggregates.find((item) => item.host === 'macbook').cpu_core_seconds, 30);

  store.close();
  const reopened = new Store({ dbPath: join(dir, 'record.json'), attachmentsDir: join(dir, 'attachments') });
  assert.equal(reopened.getGoal(goal.id).reports.length, 1);
});

test('stale is derived rather than declared by the agent', () => {
  const { store } = fixture(1);
  const goal = store.createGoal({ title: 'Old work', originalGoal: 'An old goal.', agent: 'Codex', sessionKey: 'old-session', supervised: true });
  store.data.goals[0].started_at = '2020-01-01T00:00:00.000Z';
  assert.equal(store.deriveStatus(store.data.goals[0]), 'STALE');
  assert.throws(() => store.addReport(goal.id, { type: 'UPDATE', headline: 'Bad', bottomLine: 'Bad', blocking: true }), /Only REQUEST/);
});

test('running sessions are deduplicated, linked to goals, and can be starred', () => {
  const { store } = fixture();
  const discovered = { runtime_key: 'mac:Codex:thread-1', provider: 'Codex', session_key: 'thread-1', identity_authoritative: true, pid: 42, role: 'MAIN', last_seen_at: '2026-09-15T12:00:00.000Z', running: true, working_directory: '/repo' };
  store.syncSessions([discovered]);
  const goal = store.createGoal({ title: 'Inspect parser', originalGoal: 'Inspect it.', agent: 'Codex', sessionKey: 'thread-1', workingDirectory: '/repo', supervised: true });
  const session = store.sessions()[0];
  assert.equal(session.artifact_language, 'zh-CN');
  assert.equal(goal.session_id, session.id);
  assert.equal(session.goal_count, 1);
  assert.equal(session.active_goal.id, goal.id);
  assert.equal(session.active_status, 'WORKING');
  assert.deepEqual(session.resources.latest, []);
  store.addReport(goal.id, { type: 'UPDATE', headline: 'Parser finding', bottomLine: 'Identity is stable.' });
  assert.equal(store.sessions()[0].active_status, 'REPORT_READY');
  assert.equal(store.sessions()[0].latest_report.bottom_line, 'Identity is stable.');
  store.setSessionStar(session.id, true);
  store.setSessionSettings(session.id, { artifactLanguage: 'en', model: 'gpt-test' });
  store.syncSessions([discovered]);
  assert.equal(store.sessions()[0].starred, true);
  assert.equal(store.sessions()[0].artifact_language, 'en');
  assert.equal(store.sessions()[0].model, 'gpt-test');
  assert.throws(() => store.setSessionSettings(session.id, { artifactLanguage: 'made-up' }), /Unsupported/);
});

test('discovered sessions remain dormant until explicitly supervised', () => {
  const { store } = fixture();
  store.syncSessions([{ runtime_key: 'mac:Cursor:one', provider: 'Cursor Agent', session_key: 'one', identity_authoritative: true, pid: 7, role: 'MAIN', last_seen_at: '2026-09-15T12:00:00.000Z', running: true }]);
  const session = store.sessions()[0];
  assert.equal(session.supervised, false);
  assert.throws(() => store.createGoal({ title: 'Hidden', originalGoal: 'Do not monitor yet.', agent: 'Cursor Agent', sessionKey: 'one' }), /not supervised/);
  store.setSessionSupervised(session.id, true);
  const goal = store.createGoal({ title: 'Selected', originalGoal: 'Monitor this session.', agent: 'Cursor Agent', sessionKey: 'one' });
  assert.equal(goal.session_id, session.id);
});

test('provider identity upgrades a supervised process fallback without splitting the session', () => {
  const { store } = fixture();
  const processKey = 'process-42-1000';
  store.syncSessions([{ runtime_key: 'mac:Claude:process', provider: 'Claude Code', session_key: processKey, identity_authoritative: false, pid: 42, role: 'MAIN', last_seen_at: '2026-09-15T12:00:00.000Z', running: true }]);
  const session = store.sessions()[0];
  store.setSessionSupervised(session.id, true);
  const goal = store.createGoal({ title: 'Existing Claude', originalGoal: 'Supervise it.', agent: 'Claude Code', sessionKey: processKey, resumeId: processKey });
  store.syncSessions([{ runtime_key: 'mac:Claude:provider', provider: 'Claude Code', session_key: 'claude-real-id', identity_authoritative: true, pid: 42, role: 'MAIN', last_seen_at: '2026-09-15T12:01:00.000Z', running: true }]);
  const upgraded = store.sessions()[0];
  assert.equal(upgraded.id, session.id);
  assert.equal(upgraded.session_key, 'claude-real-id');
  assert.equal(store.getGoal(goal.id).goal.resume_id, 'claude-real-id');
});

test('lab meetings group core-session directives and collect one report per goal', () => {
  const { store } = fixture();
  const first = store.createGoal({ title: 'Retrieval study', originalGoal: 'Evaluate retrieval.', agent: 'Codex', sessionKey: 'meeting-codex', supervised: true });
  const second = store.createGoal({ title: 'Compiler study', originalGoal: 'Evaluate the compiler.', agent: 'Claude Code', sessionKey: 'meeting-claude', supervised: true });
  store.setSessionStar(first.session_id, true);
  store.setSessionStar(second.session_id, true);
  const meetingId = 'meeting-001';
  store.addDirective(first.id, { body: 'Report for the lab meeting.', kind: 'LAB_MEETING_REQUEST', meetingId, meetingTitle: 'Weekly review' });
  store.addDirective(second.id, { body: 'Report for the lab meeting.', kind: 'LAB_MEETING_REQUEST', meetingId, meetingTitle: 'Weekly review' });
  store.addReport(first.id, { meetingId, type: 'UPDATE', headline: 'Retrieval result', bottomLine: 'Recall increased by 0.04.' });
  let meeting = store.getLabMeeting(meetingId);
  assert.equal(meeting.status, 'COLLECTING');
  assert.equal(meeting.received, 1);
  assert.equal(meeting.total, 2);
  store.addReport(second.id, { type: 'REQUEST', headline: 'Compiler decision', bottomLine: 'Two migration paths remain.', blocking: true, choices: ['A', 'B'] });
  meeting = store.getLabMeeting(meetingId);
  assert.equal(meeting.status, 'READY');
  assert.equal(meeting.received, 2);
  assert.equal(meeting.needs_you, 1);
  assert.equal(meeting.participants.find((item) => item.goal.id === second.id).report.meeting_id, meetingId);
});
