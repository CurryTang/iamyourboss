import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, uninstall } from '../src/install.mjs';

test('installer adds and removes all four providers without overwriting existing config', () => {
  const root = mkdtempSync(join(tmpdir(), 'iyb-install-'));
  const fakeBin = join(root, 'bin'); mkdirSync(fakeBin);
  for (const command of ['claude','codex','agy','cursor-agent']) {
    const path = join(fakeBin, command); writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755);
  }
  const originalPath = process.env.PATH; process.env.PATH = `${fakeBin}:${originalPath}`;
  mkdirSync(join(root, '.cursor'), { recursive: true });
  writeFileSync(join(root, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: { existing: { url: 'https://example.test/mcp' } } })}\n`);
  const legacySkill = join(root, '.cursor', 'skills-cursor', 'iyb-progress-brief');
  mkdirSync(legacySkill, { recursive: true });
  writeFileSync(join(legacySkill, '.iamyourboss-managed'), 'managed by iamyourboss\n');
  try {
    const results = install({ home: root });
    assert.deepEqual(results.map((item) => item.name), ['Claude Code','Codex','Agy','Cursor Agent']);
    assert.ok(results.every((item) => item.installed));
    assert.match(readFileSync(join(root, '.claude', 'CLAUDE.md'), 'utf8'), /iamyourboss advisor mode/);
    assert.match(readFileSync(join(root, '.codex', 'AGENTS.md'), 'utf8'), /iamyourboss advisor mode/);
    assert.ok(JSON.parse(readFileSync(join(root, '.gemini', 'config', 'hooks.json'), 'utf8')).iamyourboss.PreInvocation);
    const cursorMcp = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cursorMcp.mcpServers.existing);
    assert.equal(cursorMcp.mcpServers.iamyourboss.env.IYB_AGENT, 'Cursor Agent');
    assert.ok(JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')).hooks.sessionStart);
    for (const skillRoot of [join(root, '.claude', 'skills'), join(root, '.codex', 'skills'), join(root, '.cursor', 'skills'), join(root, '.gemini', 'config', 'skills')]) {
      const installedSkill = join(skillRoot, 'iyb-progress-brief', 'SKILL.md');
      assert.ok(existsSync(installedSkill));
      assert.match(readFileSync(installedSkill, 'utf8'), /name: iyb-progress-brief/);
    }
    for (const skillRoot of [join(root, '.claude', 'skills'), join(root, '.codex', 'skills'), join(root, '.cursor', 'skills')]) {
      assert.ok(existsSync(join(skillRoot, 'iyb-chat-with-gpt', 'SKILL.md')));
      assert.ok(existsSync(join(skillRoot, 'iyb-native-browser-control', 'SKILL.md')));
    }
    assert.equal(existsSync(join(root, '.gemini', 'config', 'skills', 'iyb-chat-with-gpt')), false);
    assert.equal(existsSync(join(root, '.gemini', 'config', 'skills', 'iyb-native-browser-control')), false);
    assert.equal(existsSync(legacySkill), false);

    uninstall({ home: root });
    assert.doesNotMatch(readFileSync(join(root, '.claude', 'CLAUDE.md'), 'utf8'), /IAMYOURBOSS_START/);
    assert.equal(JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8')).mcpServers.iamyourboss, undefined);
    assert.equal(existsSync(join(root, '.cursor', 'rules', 'iamyourboss.mdc')), false);
    assert.equal(existsSync(join(root, '.gemini', 'config', 'skills', 'iyb-progress-brief')), false);
    assert.equal(existsSync(join(root, '.cursor', 'skills', 'iyb-chat-with-gpt')), false);
  } finally { process.env.PATH = originalPath; }
});
