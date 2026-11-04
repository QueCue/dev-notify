import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseConfig } from '../dist/config.js';
import { projectAllowed, quietNow, shouldNotify } from '../dist/notifications.js';

const absolute = process.platform === 'win32' ? 'C:\\work' : '/work';
const project = path.join(absolute, '项目');
const config = (notifications = {}) => parseConfig({ notifications }, {});

test('通知配置默认全开、无静默、不过滤项目', () => {
  const value = config();
  assert.deepEqual(value.notifications, {
    events: { stop: true, waiting: true },
    projects: { allow: [], deny: [] },
    quietHours: null,
  });
});
test('通知事件、项目路径与静默时段按预期解析', () => {
  const value = config({
    events: { stop: false },
    projects: { allow: [project], deny: [absolute] },
    quiet_hours: { start: '22:00', end: '08:00' },
  });
  assert.equal(value.notifications.events.stop, false);
  assert.equal(value.notifications.events.waiting, true);
  assert.deepEqual(value.notifications.projects.allow, [project]);
  assert.deepEqual(value.notifications.projects.deny, [absolute]);
  assert.deepEqual(value.notifications.quietHours, { start: '22:00', end: '08:00' });
  assert.equal(config({ quiet_hours: { start: '09:00', end: '09:00' } }).notifications.quietHours, null);
  assert.equal(config({ quiet_hours: null }).notifications.quietHours, null);
});
test('非法通知配置被拒绝且错误信息不泄露内容', () => {
  for (const notifications of [
    { unknown: true },
    { events: { stop: 'no' } },
    { events: { other: true } },
    { projects: { allow: 'TEST_ONLY' } },
    { projects: { allow: ['relative/TEST_ONLY'] } },
    { projects: { allow: [''] } },
    { quiet_hours: { start: '24:00', end: '08:00' } },
    { quiet_hours: { start: '8:00', end: '09:00' } },
    { quiet_hours: { start: '08:00' } },
  ]) assert.throws(() => config(notifications), error => !error.message.includes('TEST_ONLY'));
});
test('静默时段支持跨午夜、边界排除与未启用', () => {
  const at = (hour, minute) => new Date(2026, 0, 1, hour, minute);
  const overnight = { start: '22:00', end: '08:00' };
  assert.equal(quietNow(overnight, at(23, 0)), true);
  assert.equal(quietNow(overnight, at(0, 0)), true);
  assert.equal(quietNow(overnight, at(7, 59)), true);
  assert.equal(quietNow(overnight, at(8, 0)), false);
  assert.equal(quietNow(overnight, at(12, 0)), false);
  const daytime = { start: '09:00', end: '17:00' };
  assert.equal(quietNow(daytime, at(9, 0)), true);
  assert.equal(quietNow(daytime, at(16, 59)), true);
  assert.equal(quietNow(daytime, at(17, 0)), false);
  assert.equal(quietNow(null, at(23, 0)), false);
});
test('项目前缀匹配 deny 优先，allow 生效时缺少路径不放行', () => {
  assert.equal(projectAllowed({ allow: [], deny: [] }, project), true);
  assert.equal(projectAllowed({ allow: [absolute], deny: [] }, project), true);
  assert.equal(projectAllowed({ allow: [absolute], deny: [] }, path.join(absolute, '另一个')), true);
  assert.equal(projectAllowed({ allow: [], deny: [absolute] }, project), false);
  assert.equal(projectAllowed({ allow: [project], deny: [absolute] }, project), false);
  assert.equal(projectAllowed({ allow: [absolute], deny: [] }, undefined), false);
  assert.equal(projectAllowed({ allow: [], deny: [absolute] }, undefined), true);
  assert.equal(projectAllowed({ allow: [absolute], deny: [] }, path.join(path.dirname(absolute), '其他')), false);
});
test('shouldNotify 组合事件开关、项目过滤和静默时段', () => {
  const quiet = config({ quiet_hours: { start: '22:00', end: '08:00' } });
  const at = (hour) => new Date(2026, 0, 1, hour, 0);
  assert.equal(shouldNotify(quiet, 'stop', project, at(23)), false);
  assert.equal(shouldNotify(quiet, 'waiting', project, at(23)), false);
  assert.equal(shouldNotify(quiet, 'stop', project, at(12)), true);
  assert.equal(shouldNotify(config({ events: { stop: false } }), 'stop', project), false);
  assert.equal(shouldNotify(config({ projects: { allow: [path.join(absolute, '其他')] } }), 'stop', project), false);
});
