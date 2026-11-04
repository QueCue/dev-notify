import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcriptEndTime } from '../dist/hook-time.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-time-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function transcript(root, lines) {
  const directory = path.join(root, 'projects', 'project');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}
const at = seconds => new Date(Date.UTC(2026, 10, 4, 10, 20, seconds));

test('读取 transcript 最后一条 assistant 记录的时间，而不是文件最后一条记录', async t => {
  const root = await temporary(t);
  const file = await transcript(root, [
    { type: 'assistant', timestamp: '2026-11-04T10:20:10.000Z' },
    { type: 'user', timestamp: '2026-11-04T10:20:20.000Z' },
    { type: 'assistant', timestamp: '2026-11-04T10:20:30.000Z' },
    { type: 'api-request', timestamp: '2026-11-04T10:20:31.000Z' },
  ]);
  assert.equal((await transcriptEndTime(file, root, at(35))).toISOString(), '2026-11-04T10:20:30.000Z');
});
test('路径越界、非 jsonl、文件缺失、旧时间与未来时间都拒绝', async t => {
  const root = await temporary(t);
  const outside = path.join(root, 'outside.jsonl');
  await writeFile(outside, JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:20:30.000Z' }) + '\n');
  const file = await transcript(root, [{ type: 'assistant', timestamp: '2026-11-04T10:20:30.000Z' }]);
  assert.equal(await transcriptEndTime(outside, root, at(35)), null);
  assert.equal(await transcriptEndTime(file.replace(/\.jsonl$/, '.txt'), root, at(35)), null);
  assert.equal(await transcriptEndTime(path.join(root, 'missing.jsonl'), root, at(35)), null);
  assert.equal(await transcriptEndTime('relative.jsonl', root, at(35)), null);
  assert.equal(await transcriptEndTime(file, root, new Date(Date.UTC(2026, 10, 4, 10, 25, 31))), null);
  assert.equal(await transcriptEndTime(file, root, new Date(Date.UTC(2026, 10, 4, 10, 19, 0))), null);
});
test('尾部没有 assistant 记录时返回空', async t => {
  const root = await temporary(t);
  const file = await transcript(root, [
    { type: 'user', timestamp: '2026-11-04T10:20:20.000Z' },
    { type: 'api-request', timestamp: '2026-11-04T10:20:31.000Z' },
  ]);
  assert.equal(await transcriptEndTime(file, root, at(35)), null);
});
