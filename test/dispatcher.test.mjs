import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandForGoal, PromptDispatcher } from '../src/dispatcher.mjs';
import { Store } from '../src/store.mjs';

test('provider adapters resume the exact Claude, Codex, Agy, and Cursor sessions', () => {
  const base = { resume_id: 'session-123' };
  assert.deepEqual(commandForGoal({ ...base, agent: 'Claude Code' }, 'hello').args.slice(0, 3), ['--print', '--resume', 'session-123']);
  assert.deepEqual(commandForGoal({ ...base, agent: 'Codex' }, 'hello').args.slice(0, 4), ['exec', 'resume', '--skip-git-repo-check', 'session-123']);
  assert.deepEqual(commandForGoal({ ...base, agent: 'Agy' }, 'hello').args.slice(0, 3), ['--conversation', 'session-123', '--print']);
  assert.deepEqual(commandForGoal({ ...base, agent: 'Cursor Agent' }, 'hello').args.slice(0, 3), ['--print', '--resume', 'session-123']);
  assert.deepEqual(commandForGoal({ ...base, agent: 'Codex' }, 'hello', {}, 'gpt-test').args.slice(0, 6), ['exec', 'resume', '--skip-git-repo-check', '--model', 'gpt-test', 'session-123']);
});

test('active terminal adapters target the exact zellij or tmux pane before provider resume', () => {
  const zellij = commandForGoal({ agent: 'Cursor Agent', resume_id: 'chat', terminal_transport: 'zellij', terminal_session: 'lab', terminal_pane: '7' }, 'hello');
  assert.deepEqual(zellij.args.slice(0, 7), ['--session', 'lab', 'action', 'write-chars', '--pane-id', '7', 'hello']);
  assert.deepEqual(zellij.submit.args.slice(-3), ['--pane-id', '7', 'Enter']);
  const tmux = commandForGoal({ agent: 'Codex', resume_id: 'thread', terminal_transport: 'tmux', terminal_pane: '%3' }, 'hello');
  assert.deepEqual(tmux.args, ['send-keys', '-t', '%3', '-l', 'hello']);
  assert.deepEqual(tmux.submit.args, ['send-keys', '-t', '%3', 'Enter']);
});

test('prompt dispatch records delivery without storing agent output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iyb-dispatch-'));
  const store = new Store({ dbPath: join(dir, 'record.json'), attachmentsDir: join(dir, 'attachments') });
  const goal = store.createGoal({ title: 'Continue experiment', originalGoal: 'Run the experiment.', agent: 'Cursor Agent', sessionKey: 'cursor-chat', promptTransport: 'cursor', supervised: true });
  store.setSessionSettings(goal.session_id, { model: 'cursor-test-model' });
  const directive = store.addDirective(goal.id, { body: 'Add the raw-row baseline.' });
  let invocation;
  const child = new EventEmitter(); child.unref = () => {};
  const dispatcher = new PromptDispatcher({ store, spawnProcess(executable, args, options) { invocation = { executable, args, options }; process.nextTick(() => child.emit('exit', 0, null)); return child; } });
  dispatcher.dispatch(goal.id, directive);
  await once(child, 'exit');
  await new Promise((resolve) => setImmediate(resolve));
  const sent = store.getGoal(goal.id).directives[0];
  assert.equal(invocation.executable, 'cursor-agent');
  assert.deepEqual(invocation.args.slice(3, 5), ['--model', 'cursor-test-model']);
  assert.match(invocation.args.at(-1), /raw-row baseline/);
  assert.match(invocation.args.at(-1), new RegExp(goal.id));
  assert.equal(invocation.options.stdio, 'ignore');
  assert.equal(sent.dispatch_status, 'SENT');
  assert.ok(sent.delivered_at);
  assert.equal(store.inbox('Cursor Agent', 'cursor-chat').directives.length, 0);
});
