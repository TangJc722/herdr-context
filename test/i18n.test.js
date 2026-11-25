import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translator, categoryLabel, windowLabel, resetsText, agoText, normLang } from '../mod/herdr-context/i18n.js';
import { spaceAgents } from '../mod/herdr-context/logic.js';
import { parseClaudeReset } from '../src/quota/claude-cli.js';

test('translator: both languages, placeholders, fallbacks', () => {
  const en = translator('en');
  const zh = translator('zh');
  assert.equal(en('title'), 'Context');
  assert.equal(zh('title'), '上下文');
  assert.equal(en('tokensOf', { used: '1k', window: '200k' }), '1k of 200k tokens');
  assert.equal(zh('requests', { n: 3 }), '3 次请求');
  assert.equal(zh('cacheHit', { pct: '98%' }), 'cache 命中 98%', 'cache stays English');
  assert.equal(zh('agents'), '本工作区的 Agents', 'agent stays English');
  assert.equal(translator('fr')('title'), 'Context');
  assert.equal(zh('no-such-key'), 'no-such-key');
  assert.equal(normLang(undefined), 'en');
});

test('labels: categories, quota windows', () => {
  assert.equal(categoryLabel('toolResult', 'zh'), '工具结果');
  assert.equal(categoryLabel('systemPrompt', 'zh'), 'System Prompt');
  assert.equal(categoryLabel('toolResult', 'en'), 'tool results');
  assert.equal(windowLabel('5h', 'zh'), '5 小时');
  assert.equal(windowLabel('week', 'zh'), '每周');
  assert.equal(windowLabel('Sonnet week', 'zh'), 'Sonnet 每周');
  assert.equal(windowLabel('Claude/GPT 5h', 'zh'), 'Claude/GPT 5 小时');
  assert.equal(windowLabel('GPT-5.5-Codex week', 'zh'), 'GPT-5.5-Codex 每周');
  assert.equal(windowLabel('week', 'en'), 'week');
});

test('times in both languages', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(resetsText('2026-11-21T14:05:00Z', 'zh', now), '2 小时 5 分后');
  assert.equal(resetsText('2026-11-24T15:00:00Z', 'zh', now), '3 天 3 小时后');
  assert.equal(resetsText('2026-11-21T14:05:00Z', 'en', now), 'in 2h 5m');
  assert.equal(resetsText('2026-11-21T11:00:00Z', 'zh', now), '即将重置');
  assert.equal(resetsText(null, 'zh', now), '');
  assert.equal(agoText(now - 5000, 'zh', now), '5 秒前');
  assert.equal(agoText(now - 300000, 'zh', now), '5 分钟前');
  assert.equal(agoText(0, 'zh', now), '尚未更新');
});

test('parseClaudeReset: the times Claude Code prints, in local time', () => {
  const now = new Date(2026, 10, 21, 12, 0).getTime(); // Nov 21, noon local
  const at = (...a) => new Date(...a).toISOString();
  assert.equal(parseClaudeReset('3pm (Asia/Shanghai)', now), at(2026, 10, 21, 15, 0));
  assert.equal(parseClaudeReset('2:20am (Asia/Shanghai)', now), at(2026, 10, 22, 2, 20), 'past today → tomorrow');
  assert.equal(parseClaudeReset('Nov 22, 2:20am (Asia/Shanghai)', now), at(2026, 10, 22, 2, 20));
  assert.equal(parseClaudeReset('Nov 27, 10pm', now), at(2026, 10, 27, 22, 0));
  assert.equal(parseClaudeReset('12am', now), at(2026, 10, 22, 0, 0));
  assert.equal(parseClaudeReset('12pm', new Date(2026, 10, 21, 9, 0).getTime()), at(2026, 10, 21, 12, 0));
  const dec = new Date(2026, 11, 30, 12, 0).getTime();
  assert.equal(parseClaudeReset('Jan 2, 9am', dec), at(2027, 0, 2, 9, 0), 'January seen in December is next year');
  assert.equal(parseClaudeReset('soon', now), null);
  assert.equal(parseClaudeReset('', now), null);
});

test('agents: generic tab names ("1", "Claude Code") show the folder', () => {
  const list = spaceAgents(
    [
      { address: 't1', pane: 'p1', space: 's', tab_name: 'Claude Code', app: 'claude-code', status: 'idle' },
      { address: 't2', pane: 'p2', space: 's', tab_name: '短线情绪分析', app: 'claude-code', status: 'idle' },
      { address: 't3', pane: 'p3', space: 's', tab_name: '2', app: 'claude-code', status: 'idle' },
    ],
    [{ pane: 'p1', cwd: 'C:\\work\\deck-ui' }, { pane: 'p2', cwd: 'C:\\work\\stocks' }, { pane: 'p3', cwd: '/w/api' }],
    [],
    's',
  );
  assert.deepEqual(list.map((a) => a.title), ['deck-ui', '短线情绪分析', 'api']);
});
