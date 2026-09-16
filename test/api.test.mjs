import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

test('HTTP API completes goal, request, decision, directive, and resource flow', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iyb-api-'));
  const store = new Store({ dbPath: join(dir, 'record.json'), attachmentsDir: join(dir, 'attachments') });
  const { server } = createApp({ store, dataDir: dir, port: 0, dispatcher: { dispatch() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `${method} ${path} returned ${response.status}`); return response.json();
  };
  const identified = await call('/api/sessions/identify', 'POST', { provider: 'Codex', sessionKey: 'api-session', workingDirectory: '/repo' });
  assert.equal(identified.supervised, false);
  const supervised = await call(`/api/sessions/${identified.id}/supervise`, 'POST', { supervised: true });
  assert.equal(supervised.goal.session_id, identified.id);
  assert.equal(supervised.directive.kind, 'REPORT_REQUEST');
  const goal = await call('/api/goals', 'POST', { title: 'Migrate cache', originalGoal: 'Choose and implement a cache policy.', agent: 'Codex', sessionKey: 'api-session' });
  const sessionId = identified.id;
  assert.equal((await call(`/api/sessions/${sessionId}`)).session.artifact_language, 'zh-CN');
  await call(`/api/sessions/${sessionId}/settings`, 'POST', { artifactLanguage: 'ja', model: 'gpt-test' });
  assert.equal((await call(`/api/sessions/${sessionId}`)).session.model, 'gpt-test');
  await call(`/api/sessions/${sessionId}/star`, 'POST', { starred: true });
  assert.equal((await call(`/api/sessions/${sessionId}`)).session.starred, true);
  const request = await call(`/api/goals/${goal.id}/reports`, 'POST', { type: 'REQUEST', headline: 'Policy required', bottomLine: 'Both options are viable.', blocking: true, choices: ['A','B'] });
  assert.equal((await call('/api/dashboard')).NEEDS_YOU.length, 1);
  await call(`/api/reports/${request.id}/decision`, 'POST', { choice: 'B', comment: 'Prefer simplicity.' });
  const inbox = await call('/api/sessions/Codex/api-session/inbox');
  assert.ok(inbox.directives.some((item) => item.kind === 'DECISION'));
  await call(`/api/goals/${goal.id}/request-report`, 'POST');
  const progressRequest = store.getGoal(goal.id).directives.at(-1);
  assert.equal(progressRequest.kind, 'REPORT_REQUEST');
  assert.match(progressRequest.body, /self-contained offline HTML progress artifact/);
  assert.match(progressRequest.body, /Do not include terminal logs/);
  assert.match(progressRequest.body, /Japanese/);
  await call(`/api/goals/${goal.id}/resources`, 'POST', { host: 'gpu-box', scope: 'remote', cpuPercent: 250, rssBytes: 1024, processCount: 4 });
  assert.equal((await call(`/api/goals/${goal.id}`)).resources.latest[0].scope, 'remote');
  const artifact = await call(`/api/goals/${goal.id}/reports`, 'POST', { type: 'UPDATE', headline: 'Comparison ready', bottomLine: 'The selected configuration wins.', attachments: [{ name: 'result.html', mimeType: 'text/html', dataBase64: Buffer.from('<!doctype html><table><tr><td>0.91</td></tr></table>').toString('base64') }] });
  const artifactResponse = await fetch(`${base}/api/attachments/${artifact.attachments[0].id}`);
  assert.match(artifactResponse.headers.get('content-security-policy'), /connect-src 'none'/);
  await call(`/api/goals/${goal.id}/reports`, 'POST', { type: 'FINAL', headline: 'Migration complete', bottomLine: 'Policy B is implemented.' });
  assert.equal((await call('/api/dashboard')).DONE.length, 1);
});

test('HTTP API starts a lab meeting for selected core sessions and tracks responses', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iyb-meeting-api-'));
  const store = new Store({ dbPath: join(dir, 'record.json'), attachmentsDir: join(dir, 'attachments') });
  const dispatched = [];
  const { server } = createApp({ store, dataDir: dir, port: 0, dispatcher: { dispatch(goalId, directive) { dispatched.push({ goalId, directive }); } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `${method} ${path} returned ${response.status}`); return response.json();
  };
  const sessions = [];
  for (const [provider, key] of [['Codex', 'meeting-api-codex'], ['Claude Code', 'meeting-api-claude']]) {
    const session = await call('/api/sessions/identify', 'POST', { provider, sessionKey: key, workingDirectory: `/synthetic/${key}` });
    await call(`/api/sessions/${session.id}/supervise`, 'POST', { supervised: true });
    await call(`/api/sessions/${session.id}/star`, 'POST', { starred: true });
    sessions.push(session);
  }
  const meeting = await call('/api/lab-meetings', 'POST', { sessionIds: sessions.map((item) => item.id), title: 'Synthetic weekly review' });
  assert.equal(meeting.total, 2);
  assert.equal(meeting.received, 0);
  assert.equal(meeting.status, 'COLLECTING');
  assert.equal(dispatched.filter((item) => item.directive.kind === 'LAB_MEETING_REQUEST').length, 2);
  assert.match(dispatched.at(-1).directive.body, new RegExp(meeting.id));
  for (const participant of meeting.participants) await call(`/api/goals/${participant.goal.id}/reports`, 'POST', { meetingId: meeting.id, type: 'UPDATE', headline: `${participant.goal.title} update`, bottomLine: 'The current checkpoint is stable.' });
  const completed = await call(`/api/lab-meetings/${meeting.id}`);
  assert.equal(completed.status, 'READY');
  assert.equal(completed.received, 2);
  assert.equal((await call('/api/dashboard')).meetings[0].id, meeting.id);
});
