import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTaskCompletion } from '../src/completion-evaluator.js';
import { assessTaskResult } from '../src/failure-classifier.js';
import { finalTurnOutput } from '../src/turn-output.js';
const command = (command, exitCode, cwd = '/repo') => ({type:'commandExecution',command,exitCode,cwd});
const verdict = executionItems => evaluateTaskCompletion({contract:{taskKind:'test',outputs:['report']},result:{turn:{status:'completed'},evidenceComplete:true,output:'done',executionItems}});
test('unknown test exit requires evidence inspection, not success or automatic rework',()=>{
  const v=verdict([command('node --test',undefined)]);
  assert.equal(v.decision,'attention'); assert.equal(v.retryable,false); assert.equal(v.nextAction,'inspect_execution_evidence');
});
test('test executable paths and runtime flags are recognized without trusting echoed commands',()=>{
  assert.equal(verdict([command('/usr/bin/node --experimental-strip-types --test test/a.js',0)]).decision,'accept');
  assert.notEqual(verdict([command('echo "node --test"',0)]).decision,'accept');
  assert.notEqual(verdict([command('python3 -c "run tests"',0)]).decision,'accept');
  assert.equal(verdict([command("/bin/zsh -lc '/usr/bin/node --test'",0)]).decision,'accept');
  assert.notEqual(verdict([command("/bin/zsh -lc 'node --test; echo success'",0)]).decision,'accept');
  assert.notEqual(verdict([command("/bin/zsh -lc 'echo node --test'",0)]).decision,'accept');
});
test('only a later successful same test in the same workspace supersedes failure',()=>{
  const result=items=>assessTaskResult({turn:{status:'completed'},output:'done',executionItems:items});
  assert.equal(result([command('node --test a.js',1),command('node --test a.js',0)]),null);
  assert.ok(result([command('node --test a.js',1),command('node --test b.js',0)]));
  assert.ok(result([command('node --test a.js',1),command('node --test a.js',0,'/other')]));
  assert.ok(result([command('git push',1),command('git push',0)]));
});
test('explicit commentary is never a final answer but unphased legacy messages remain supported',()=>{
  assert.equal(finalTurnOutput({items:[{type:'agentMessage',phase:'commentary',text:'starting'}]}),'');
  assert.equal(finalTurnOutput({items:[{type:'agentMessage',text:'done'}]}),'done');
});

test('wrapper prose is insufficient but a separately observed child test receipt works',()=>{
  const wrapper=command('python3 runner.py',0);
  assert.equal(verdict([wrapper]).decision,'attention');
  assert.equal(verdict([wrapper,command('node --test a.js',0)]).decision,'accept');
});

test('a historical failure mentioned in prose does not overturn verified same-target recovery',()=>{
  assert.equal(assessTaskResult({turn:{status:'completed'},output:'Initially exit code 1, then fixed and verified.',
    executionItems:[command('node --test a.js',1),command('node --test a.js',0)]}),null);
});
