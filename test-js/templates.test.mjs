import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../dist/config.js';
import { formatTime, renderFooter } from '../dist/claude-hook.js';

const config = templates => parseConfig({ templates }, {});

test('footer 模板默认不启用，合法模板与空字符串保留', () => {
  assert.deepEqual(config().templates, { footer: null });
  assert.deepEqual(config({ footer: null }).templates, { footer: null });
  assert.deepEqual(config({ footer: '项目：{project}\n会话：{session}' }).templates,
    { footer: '项目：{project}\n会话：{session}' });
  assert.deepEqual(config({ footer: '' }).templates, { footer: '' });
});
test('footer 模板非法值被拒绝且不回显内容', () => {
  for (const templates of [
    { unknown: 'TEST_ONLY' },
    { footer: 1 },
    { footer: 'TEST_ONLY'.repeat(200) },
    { footer: 'TEST_ONLY\u0000' },
  ]) assert.throws(() => config(templates), error => !error.message.includes('TEST_ONLY'));
});
test('renderFooter 替换已知变量，未知占位符和缺失值保持可预期', () => {
  const data = { cwd: 'C:\\work\\项目', session_id: 'sess-1' };
  assert.equal(renderFooter('P={project}\nT={topic}\nS={session}', data, '主题'),
    'P=C:\\work\\项目\nT=主题\nS=sess-1');
  assert.equal(renderFooter('{unknown}', data, ''), '{unknown}');
  assert.equal(renderFooter('T={topic}', data, ''), 'T=');
  assert.equal(renderFooter('', data, ''), '');
  assert.equal(renderFooter('{project}', { cwd: 'a\u0000b' }, ''), 'a b');
  assert.equal(renderFooter('T={time}', data, '', '2026-11-04 18:31:16'), 'T=2026-11-04 18:31:16');
  assert.equal(formatTime(new Date(2026, 10, 4, 18, 31, 16)), '2026-11-04 18:31:16');
});
