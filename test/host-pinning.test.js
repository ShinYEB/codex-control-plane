import test from 'node:test';
import assert from 'node:assert/strict';
import {hostPinning} from '../src/host-pinning.js';
import {workStatus} from '../src/work-status.js';
import {ControlRegistry} from '../src/registry.js';
import {McpControlServer} from '../src/mcp-server.js';
const threadId='01a070b9-4fce-7402-9299-bd5f88ebc539';

test('pin handoff exposes only a valid requested thread and never confirms host state',()=>{
  for(const id of [null,'invalid','javascript:bad']) assert.equal(hostPinning(id,true).hostAction,undefined);
  assert.equal(hostPinning(threadId,false).hostAction,undefined);
  const pin=hostPinning(threadId,true);
  assert.deepEqual(pin.hostAction,{tool:'move_thread_to_sidebar_section',arguments:{threadId,sectionId:'pinned'}});
  assert.equal(pin.confirmed,false);
  assert.equal(pin.verification.collection,'pinnedThreads');
});

test('status waits for the representative identity without invoking the execution plane',async()=>{
  const registry=new ControlRegistry({path:':memory:'});
  const server=new McpControlServer({registry,recoverInterruptedTasks:false,controlFactory:()=>{throw new Error('No execution');}});
  try {
    registry.createRun({id:'r',status:'running',metadata:{controlRequest:{pin:true}}});
    assert.equal(workStatus(registry,registry.getRun('r')).pinning.status,'waiting_for_thread');
    const pending=server.handleRequest({method:'tools/call',params:{name:'get_work_status',arguments:{runId:'r',waitForThreadMs:1000}}});
    registry.upsertAgent({id:threadId,status:'idle'});
    registry.updateRun('r',{metadata:{orchestratorAgentId:threadId}});
    const response=await pending;
    assert.equal(response.structuredContent.works[0].pinning.hostAction.arguments.threadId,threadId);
    assert.equal(registry.listTasks({runId:'r'}).length,0);
    registry.updateRun('r',{metadata:{controlRequest:{pin:false}}});
    assert.equal(workStatus(registry,registry.getRun('r')).pinning.status,'not_requested');
  } finally {await server.close();}
});
