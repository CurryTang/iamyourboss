import { spawn } from 'node:child_process';

function provider(agent = '', transport = '') {
  const value = `${transport} ${agent}`.toLowerCase();
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('agy') || value.includes('antigravity')) return 'agy';
  if (value.includes('claude')) return 'claude';
  if (value.includes('codex')) return 'codex';
  return null;
}

export function commandForGoal(goal, prompt, commands = {}, model = null) {
  if (goal.terminal_transport === 'zellij' && goal.terminal_session && goal.terminal_pane != null) {
    const executable = commands.zellij || 'zellij';
    const target = ['--session', goal.terminal_session, 'action'];
    return {
      kind: 'zellij', executable, args: [...target, 'write-chars', '--pane-id', goal.terminal_pane, prompt],
      submit: { executable, args: [...target, 'send-keys', '--pane-id', goal.terminal_pane, 'Enter'] },
    };
  }
  if (goal.terminal_transport === 'tmux' && goal.terminal_pane) {
    const executable = commands.tmux || 'tmux';
    return {
      kind: 'tmux', executable, args: ['send-keys', '-t', goal.terminal_pane, '-l', prompt],
      submit: { executable, args: ['send-keys', '-t', goal.terminal_pane, 'Enter'] },
    };
  }
  const kind = provider(goal.agent, goal.prompt_transport);
  const session = goal.resume_id || goal.session_key;
  if (!kind || !session) return null;
  const executable = commands[kind] || ({ claude: 'claude', codex: 'codex', agy: 'agy', cursor: 'cursor-agent' })[kind];
  if (kind === 'claude') return { kind, executable, args: ['--print', '--resume', session, ...(model ? ['--model', model] : []), '--permission-prompts', 'none', prompt] };
  if (kind === 'codex') return { kind, executable, args: ['exec', 'resume', '--skip-git-repo-check', ...(model ? ['--model', model] : []), session, prompt] };
  if (kind === 'agy') return { kind, executable, args: ['--conversation', session, ...(model ? ['--model', model] : []), '--print', '--output-format', 'json', prompt] };
  return { kind, executable, args: ['--print', '--resume', session, ...(model ? ['--model', model] : []), '--output-format', 'json', prompt] };
}

function advisorPrompt(goal, directive) {
  const lead = directive.kind === 'REPORT_REQUEST' ? 'The advisor requested a report.' : directive.kind === 'DECISION' ? 'The advisor answered your decision request.' : 'The advisor sent a directive.';
  return `${lead}\n\nGoal: ${goal.title}\nGoal record ID: ${goal.id}\n\n${directive.body}\n\nTreat this as the next advisor turn. Continue working autonomously. Do not narrate routine activity; use iamyourboss report/request/finish for the next advisor-worthy result. If the MCP tool does not already have active goal context, pass goalId exactly as ${goal.id}.`;
}

export class PromptDispatcher {
  constructor({ store, changed = () => {}, commands = {}, spawnProcess = spawn }) {
    this.store = store; this.changed = changed; this.commands = commands; this.spawnProcess = spawnProcess; this.queues = new Map();
  }

  dispatch(goalId, directive) {
    const previous = this.queues.get(goalId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.run(goalId, directive));
    this.queues.set(goalId, task);
    void task.finally(() => { if (this.queues.get(goalId) === task) this.queues.delete(goalId); });
  }

  run(goalId, directive) {
    const record = this.store.getGoal(goalId);
    if (!record) return Promise.resolve();
    const selectedModel = this.store.getSession(record.goal.session_id)?.session.model || null;
    const spec = commandForGoal(record.goal, advisorPrompt(record.goal, directive), this.commands, selectedModel);
    if (!spec) {
      this.store.updateDirectiveDispatch(directive.id, { status: 'HOOK_PENDING', error: 'No resumable provider session is registered.' });
      this.changed('directive-delivery', directive.id); return Promise.resolve();
    }
    this.store.updateDirectiveDispatch(directive.id, { status: 'RUNNING' });
    this.changed('directive-delivery', directive.id);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (status, error = null, delivered = false) => {
        if (finished) return; finished = true;
        this.store.updateDirectiveDispatch(directive.id, { status, error, delivered }); this.changed('directive-delivery', directive.id); resolve();
      };
      const spawnStep = (step, onSuccess) => {
        let child;
        try {
          child = this.spawnProcess(step.executable, step.args, {
          cwd: record.goal.working_directory || process.cwd(),
          env: { ...process.env, IYB_AGENT: record.goal.agent, IYB_SESSION_ID: record.goal.session_key, IYB_GOAL_ID: goalId },
          stdio: 'ignore', detached: false,
          });
        } catch (error) { finish('FAILED', error.message); return; }
        child.once('error', (error) => finish('FAILED', error.message));
        child.once('exit', (code, signal) => {
          if (code !== 0) finish('FAILED', `Agent process exited ${signal || code}`);
          else onSuccess();
        });
        child.unref?.();
      };
      spawnStep(spec, () => spec.submit ? spawnStep(spec.submit, () => finish('SENT', null, true)) : finish('SENT', null, true));
    });
  }
}
