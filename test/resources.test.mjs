import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, summarizeTree, gpuMemory } from '../src/resources.mjs';

test('process sampler attributes only the selected session tree', () => {
  const rows = parsePs(`100 1 12.5 1000 codex\n101 100 5.5 500 node mcp\n102 101 80.0 2000 python train.py\n200 1 99.0 9000 unrelated\n`);
  assert.deepEqual(summarizeTree(rows, 100), { cpuPercent: 98, rssBytes: 3_584_000, processCount: 3 });
  assert.equal(gpuMemory('102, 4096\n200, 8192\n', new Set([100, 101, 102])), 4 * 1024 * 1024 * 1024);
});
