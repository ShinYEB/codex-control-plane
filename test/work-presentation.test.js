import test from 'node:test';
import assert from 'node:assert/strict';
import { workStatus } from '../src/work-status.js';

const id = '01a070b9-4fce-7402-9299-bd5f88ebc539';
function status(tasks, metadata = {}, agentId = id) {
  return workStatus({ listTasks: () => tasks, getAgent: () => ({ id: agentId }) },
    { id: 'run', name: 'Work', status: 'running', metadata });
}
test('single work offers its real link without a default dashboard', () => {
  const r = status([{ agentId: id, status: 'running' }]);
  assert.equal(r.presentation.kind, 'single');
  assert.equal(r.presentation.workUrl, `codex://threads/${id}`);
  assert.equal(r.presentation.initialPanel, null);
});
test('orchestrated work offers a run-scoped compact panel handoff', () => {
  const r = status([{ status: 'running' }, { status: 'blocked' }], { orchestratorAgentId: id });
  assert.equal(r.presentation.kind, 'orchestrated');
  assert.deepEqual(r.presentation.initialPanel, { tool: 'show_work_progress', arguments: { runId: 'run' } });
  assert.equal(r.presentation.workUrl, `codex://threads/${id}`);
  assert.equal(r.presentation.opened, undefined);
});
test('preparation and missing or invalid representative never fabricate a link', () => {
  assert.deepEqual(status([]).presentation, {kind:'preparing',workUrl:null,initialPanel:null});
  assert.equal(status([{}, {}]).presentation.initialPanel, null);
  assert.equal(status([{}, {}], {orchestratorAgentId:id}, 'invalid').presentation.workUrl, null);
});
