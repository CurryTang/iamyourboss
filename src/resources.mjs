import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';

const execFileAsync = promisify(execFile);

function parsePs(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rssKb: Number(match[4]), command: match[5] } : null;
  }).filter(Boolean);
}

function selectTree(processes, rootPid) {
  const selected = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) if (selected.has(proc.ppid) && !selected.has(proc.pid)) { selected.add(proc.pid); changed = true; }
  }
  return { selected, rows: processes.filter((proc) => selected.has(proc.pid)) };
}

function summarizeTree(processes, rootPid) {
  const { rows } = selectTree(processes, rootPid);
  return {
    cpuPercent: Math.round(rows.reduce((sum, proc) => sum + proc.cpu, 0) * 10) / 10,
    rssBytes: rows.reduce((sum, proc) => sum + proc.rssKb * 1024, 0),
    processCount: rows.length,
  };
}

function gpuMemory(stdout, selected) {
  return stdout.trim().split('\n').reduce((sum, line) => {
    const [pid, memoryMb] = line.split(',').map((value) => value.trim());
    return selected.has(Number(pid)) && Number.isFinite(Number(memoryMb)) ? sum + Number(memoryMb) * 1048576 : sum;
  }, 0);
}

async function localGpu(processes, rootPid) {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'], { timeout: 4_000 });
    return gpuMemory(stdout, selectTree(processes, rootPid).selected);
  } catch { return 0; }
}

async function ps(args, options = {}) {
  const { stdout } = await execFileAsync('ps', args, { timeout: 4_000, maxBuffer: 2_000_000, ...options });
  return parsePs(stdout);
}

export async function sampleLocal(rootPid = process.ppid, scope = 'local') {
  const processes = await ps(['-axo', 'pid=,ppid=,%cpu=,rss=,command=']);
  return { host: hostname(), scope, ...summarizeTree(processes, rootPid), gpuMemoryBytes: await localGpu(processes, rootPid) };
}

export async function sampleRemote({ target, pid, label }) {
  if (!/^[a-zA-Z0-9_.@:-]+$/.test(target)) throw new Error('Unsafe SSH target');
  const baseArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', target];
  const [processResult, gpuResult] = await Promise.all([
    execFileAsync('ssh', [...baseArgs, 'ps -axo pid=,ppid=,%cpu=,rss=,command='], { timeout: 7_000, maxBuffer: 2_000_000 }),
    execFileAsync('ssh', [...baseArgs, 'nvidia-smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits'], { timeout: 7_000, maxBuffer: 500_000 }).catch(() => ({ stdout: '' })),
  ]);
  const processes = parsePs(processResult.stdout);
  return { host: label || target, scope: 'remote', ...summarizeTree(processes, pid), gpuMemoryBytes: gpuMemory(gpuResult.stdout, selectTree(processes, pid).selected) };
}

export function startResourceSampler({ goalId, rootPid = process.ppid, localScope = 'local', remoteTargets = [], send, intervalMs = 10_000, onError = () => {} }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const tasks = [sampleLocal(rootPid, localScope), ...remoteTargets.map(sampleRemote)];
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'fulfilled') await send(goalId, result.value).catch(onError);
      else onError(result.reason);
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

export { parsePs, summarizeTree, gpuMemory };
