/**
 * Tests for the subagent + per-session extensions to server/aggregates-store.js
 * (plan 3.2 / 3.3): getSessions(), getSubagents(), the two-level subagent walk
 * under <projDir>/<sessionId>/subagents/, the toolUseResult agentType join,
 * and decomposeSubagentPath (the watcher routing fix).
 */
import assert from 'assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { AggregatesStore, decomposeSubagentPath } from '../../server/aggregates-store.js';

console.log('subagents-aggregation tests:\n');

// ─── Fixture builders ────────────────────────────────────────────────────────

function assistantLine({ ts, sessionId, model = 'claude-sonnet-4-6', tokens = {}, toolUses = 0 }) {
  const content = [];
  for (let i = 0; i < toolUses; i++) {
    content.push({ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: {} });
  }
  content.push({ type: 'text', text: 'response' });
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId,
    cwd: '/work/my-project',
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: tokens.input || 0,
        output_tokens: tokens.output || 0,
        cache_read_input_tokens: tokens.cacheRead || 0,
        cache_creation_input_tokens: tokens.cacheWrite || 0,
      },
      content,
    },
  });
}

function userLine({ ts, sessionId, text = 'hello' }) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId,
    cwd: '/work/my-project',
    message: { role: 'user', content: text },
  });
}

/** Parent-transcript line carrying the Agent-dispatch result for agentId */
function agentResultLine({ ts, sessionId, agentId, agentType, status = 'completed', prompt = 'do the thing' }) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId,
    cwd: '/work/my-project',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
    toolUseResult: {
      agentId,
      agentType,
      status,
      prompt,
      totalDurationMs: 5000,
      totalToolUseCount: 7,
      content: [],
    },
  });
}

function seed(projectsDir, projName, sessionId, lines) {
  const projDir = join(projectsDir, projName);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function seedAgent(projectsDir, projName, sessionId, agentId, lines) {
  const subDir = join(projectsDir, projName, sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const path = join(subDir, `agent-${agentId}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

// ─── getSessions ─────────────────────────────────────────────────────────────

test('getSessions returns per-session detail sorted newest-first', async () => {
  await withTmp(async (tmp) => {
    seed(tmp, 'proj-a', 's-old', [
      userLine({ ts: '2026-06-01T10:00:00Z', sessionId: 's-old' }),
      assistantLine({ ts: '2026-06-01T10:05:00Z', sessionId: 's-old', tokens: { input: 1000, output: 100 }, toolUses: 2 }),
    ]);
    seed(tmp, 'proj-b', 's-new', [
      userLine({ ts: '2026-06-10T10:00:00Z', sessionId: 's-new' }),
      assistantLine({ ts: '2026-06-10T10:09:00Z', sessionId: 's-new', model: 'claude-opus-4-7', tokens: { input: 500 } }),
    ]);

    const store = new AggregatesStore(tmp);
    await store.loadAll();
    const { sessions, total } = store.getSessions();

    assert.strictEqual(total, 2);
    assert.strictEqual(sessions[0].sessionId, 's-new', 'newest lastTs first');
    assert.strictEqual(sessions[0].projectDir, 'proj-b');
    assert.strictEqual(sessions[0].primaryModel, 'claude-opus-4-7');
    assert.strictEqual(sessions[1].sessionId, 's-old');
    assert.strictEqual(sessions[1].messageCount, 2);
    assert.strictEqual(sessions[1].toolCallCount, 2);
    assert.ok(sessions[1].models['claude-sonnet-4-6'], 'models serialized as plain object');
    assert.strictEqual(sessions[1].models['claude-sonnet-4-6'].input, 1000);
    assert.strictEqual(sessions[1].durationMs, 5 * 60 * 1000);
  }, 'sess-detail');
});

// ─── getSubagents ────────────────────────────────────────────────────────────

test('subagent walk + toolUseResult join produces typed agent records', async () => {
  await withTmp(async (tmp) => {
    seed(tmp, 'proj-a', 'parent-1', [
      userLine({ ts: '2026-06-10T10:00:00Z', sessionId: 'parent-1' }),
      agentResultLine({ ts: '2026-06-10T10:10:00Z', sessionId: 'parent-1', agentId: 'abc123', agentType: 'Explore', status: 'completed', prompt: 'find the configs' }),
    ]);
    seedAgent(tmp, 'proj-a', 'parent-1', 'abc123', [
      userLine({ ts: '2026-06-10T10:01:00Z', sessionId: 'parent-1', text: 'find the configs' }),
      assistantLine({ ts: '2026-06-10T10:04:00Z', sessionId: 'parent-1', model: 'claude-haiku-4-5', tokens: { input: 2000, output: 300 }, toolUses: 3 }),
    ]);
    // Orphan agent: no toolUseResult in any parent → type/status unknown
    seedAgent(tmp, 'proj-a', 'parent-1', 'orphan9', [
      userLine({ ts: '2026-06-10T11:00:00Z', sessionId: 'parent-1', text: 'orphaned dispatch prompt' }),
      assistantLine({ ts: '2026-06-10T11:02:00Z', sessionId: 'parent-1', tokens: { input: 100 } }),
    ]);

    const store = new AggregatesStore(tmp);
    await store.loadAll();
    const { agents, byType, totalAgents } = store.getSubagents();

    assert.strictEqual(totalAgents, 2);

    const typed = agents.find((a) => a.agentId === 'abc123');
    assert.strictEqual(typed.agentType, 'Explore', 'type joined from parent toolUseResult');
    assert.strictEqual(typed.status, 'completed');
    assert.strictEqual(typed.prompt, 'find the configs');
    assert.strictEqual(typed.parentSessionId, 'parent-1');
    assert.strictEqual(typed.projectDir, 'proj-a');
    assert.strictEqual(typed.primaryModel, 'claude-haiku-4-5');
    assert.strictEqual(typed.totalTokens, 2300);
    assert.strictEqual(typed.durationMs, 5000, 'duration prefers parent toolUseResult.totalDurationMs');
    assert.strictEqual(typed.toolCallCount, 7, 'tool count prefers parent toolUseResult.totalToolUseCount');
    assert.ok(typed.totalCost > 0);

    const orphan = agents.find((a) => a.agentId === 'orphan9');
    assert.strictEqual(orphan.agentType, null, 'no parent meta → null type');
    assert.strictEqual(orphan.status, null);
    assert.strictEqual(orphan.prompt, 'orphaned dispatch prompt', 'falls back to first user message');

    const exploreRow = byType.find((r) => r.agentType === 'Explore');
    assert.strictEqual(exploreRow.runs, 1);
    assert.strictEqual(exploreRow.topModel, 'claude-haiku-4-5');
    assert.strictEqual(exploreRow.fails, 0);
    const unknownRow = byType.find((r) => r.agentType === '(unknown)');
    assert.strictEqual(unknownRow.runs, 1);
  }, 'subagents-join');
});

test('subagent transcripts do NOT inflate session aggregates', async () => {
  await withTmp(async (tmp) => {
    seed(tmp, 'proj-a', 'parent-1', [
      userLine({ ts: '2026-06-10T10:00:00Z', sessionId: 'parent-1' }),
      assistantLine({ ts: '2026-06-10T10:01:00Z', sessionId: 'parent-1', tokens: { input: 100 } }),
    ]);
    seedAgent(tmp, 'proj-a', 'parent-1', 'abc123', [
      userLine({ ts: '2026-06-10T10:01:00Z', sessionId: 'parent-1' }),
      assistantLine({ ts: '2026-06-10T10:02:00Z', sessionId: 'parent-1', tokens: { input: 9_999_999 } }),
    ]);

    const store = new AggregatesStore(tmp);
    await store.loadAll();
    assert.strictEqual(store.getAggregates().totalSessions, 1, 'agent transcript is not a session');
    assert.strictEqual(store.getSessions().total, 1);
    assert.strictEqual(store.getSubagents().totalAgents, 1);
  }, 'subagents-no-inflate');
});

test('reloadSubagent + removeSubagent maintain the map and emit subagents-update', async () => {
  await withTmp(async (tmp) => {
    seed(tmp, 'proj-a', 'parent-1', [
      userLine({ ts: '2026-06-10T10:00:00Z', sessionId: 'parent-1' }),
    ]);
    const agentPath = seedAgent(tmp, 'proj-a', 'parent-1', 'late99', [
      userLine({ ts: '2026-06-10T10:01:00Z', sessionId: 'parent-1', text: 'late agent' }),
    ]);

    const store = new AggregatesStore(tmp);
    await store.loadAll();
    // Re-seed the agent with more lines, as the live watcher would see
    writeFileSync(agentPath, [
      userLine({ ts: '2026-06-10T10:01:00Z', sessionId: 'parent-1', text: 'late agent' }),
      assistantLine({ ts: '2026-06-10T10:03:00Z', sessionId: 'parent-1', tokens: { input: 50, output: 10 } }),
    ].join('\n') + '\n');

    let updates = 0;
    store.on('subagents-update', () => updates++);
    await store.reloadSubagent('late99', agentPath, 'proj-a', 'parent-1');
    assert.strictEqual(updates, 1, 'emits subagents-update');
    assert.strictEqual(store.getSubagents().agents.find((a) => a.agentId === 'late99').messageCount, 2);

    store.removeSubagent('late99');
    assert.strictEqual(updates, 2);
    assert.strictEqual(store.getSubagents().totalAgents, 0);
  }, 'subagents-reload');
});

// ─── decomposeSubagentPath (watcher routing) ─────────────────────────────────

test('decomposeSubagentPath identifies subagent transcripts on both separators', () => {
  const fwd = decomposeSubagentPath('/home/u/.claude/projects/proj-a/sess-1/subagents/agent-abc123.jsonl');
  assert.deepStrictEqual(fwd, { projectDir: 'proj-a', parentSessionId: 'sess-1', agentId: 'abc123' });

  const win = decomposeSubagentPath('C:\\Users\\u\\.claude\\projects\\proj-a\\sess-1\\subagents\\agent-abc123.jsonl');
  assert.deepStrictEqual(win, { projectDir: 'proj-a', parentSessionId: 'sess-1', agentId: 'abc123' });

  assert.strictEqual(decomposeSubagentPath('/home/u/.claude/projects/proj-a/sess-1.jsonl'), null, 'session transcript → null');
  assert.strictEqual(decomposeSubagentPath('/x/projects/proj-a/sess-1/subagents/notagent.jsonl'), null, 'non-agent file → null');
});

summary();
