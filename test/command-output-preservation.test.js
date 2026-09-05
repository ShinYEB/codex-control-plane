import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexControlPlane, mergeTurnItems } from '../src/control-plane.js';

test('missing hydrated output does not erase live output or hide a later failure', () => {
  const [item] = mergeTurnItems([{id:'x',aggregatedOutput:'tests 5',exitCode:0}],
    [{id:'x',aggregatedOutput:null,exitCode:1}]);
  assert.equal(item.aggregatedOutput,'tests 5');
  assert.equal(item.exitCode,1);
  assert.equal(mergeTurnItems([{id:'x',aggregatedOutput:'old'}],[{id:'x',aggregatedOutput:''}])[0].aggregatedOutput,'');
});

for (const recovery of [false,true]) test(`output survives ${recovery ? 'missed terminal recovery' : 'normal hydration'}`, async () => {
  const client = new EventEmitter();
  const item={id:'cmd',type:'commandExecution',command:'node --test',exitCode:0,aggregatedOutput:null};
  const turn={id:'t',status:'completed',items:[item]};
  client.request=async method => {
    if(method==='turn/start') {
      client.emit('item/commandExecution/outputDelta',{threadId:'thread',turnId:'other',itemId:'cmd',delta:'WRONG'});
      client.emit('item/commandExecution/outputDelta',{threadId:'thread',turnId:'t',itemId:'cmd',delta:'tests 5\n'});
      client.emit('item/completed',{threadId:'thread',turnId:'t',item:{...item,aggregatedOutput:'tests 5\n'}});
      return {turn:{id:'t'}};
    }
    return {thread:{turns:[turn]}};
  };
  client.waitForNotification=async()=>{
    if(recovery) throw new Error('Timed out waiting for app-server notification');
    return {method:'turn/completed',params:{threadId:'thread',turn}};
  };
  const result=await new CodexControlPlane(client).runTask('thread','test',{timeoutMs:1000});
  assert.equal(result.executionItems[0].aggregatedOutput,'tests 5\n');
  assert.equal(result.executionItems[0].streamedOutput,'tests 5\n');
  assert.equal(result.executionItems[0].streamedOutputCompleteness,'not_guaranteed');
  assert.deepEqual(result.turn.items,result.executionItems);
  assert.equal(client.listenerCount('item/commandExecution/outputDelta'),0);
});
