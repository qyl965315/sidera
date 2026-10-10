import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:net";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {canonicalMcpServer} from "../hythes/canonical-mcp.ts";
test("Canonical MCP exposes and forwards exact semantic basis to the one Core RPC",async()=>{
 const received:Array<{method:string;params:Record<string,unknown>}>=[];
 const core=createServer(socket=>{let buffer="";socket.on("data",data=>{buffer+=data.toString();const n=buffer.indexOf("\n");if(n<0)return;
  const request=JSON.parse(buffer.slice(0,n));received.push(request);socket.write(JSON.stringify({id:request.id,result:{state:"accepted"}})+"\n");});});
 await new Promise<void>(resolve=>core.listen(0,"127.0.0.1",resolve));
 const port=(core.address() as {port:number}).port;
 const server=canonicalMcpServer({port,token:"fixture"}),client=new Client({name:"schema-fixture",version:"1"});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const list=await client.listTools();
  for(const name of ["responsibility_create","task_dispatch"]){const schema=list.tools.find(t=>t.name===name)!.inputSchema;assert.ok(schema.properties?.basis);}
  const id="00000000-0000-4000-8000-000000000001",basis={responsibilityId:id,intentRevisionId:id,contextBasis:["fixture:admitted"]};
  assert.ok(list.tools.find(t=>t.name==="task_dispatch")!.inputSchema.properties?.supervisionId);
  for(const name of ["supervision_open","supervision_view","supervision_decide","runtime_status","chief_frontend_prepare"])assert.ok(list.tools.some(t=>t.name===name));
  await client.callTool({name:"task_dispatch",arguments:{requestId:id,centerNodeId:"fixture-target",body:"fixture",basis,supervisionId:id}});
  await client.callTool({name:"responsibility_create",arguments:{requestId:id,title:"fixture",scope:"fixture",ownerNodeId:"fixture",basis:{intentRevisionId:id,contextBasis:basis.contextBasis}}});
  assert.equal(received.length,2);assert.equal(received[0]?.method,"task.submit");assert.deepEqual(received[0]?.params.basis,basis);
  assert.deepEqual(received[1]?.params.basis,{intentRevisionId:id,contextBasis:basis.contextBasis});
  assert.equal(received[0]?.params.supervisionId,id);
 }finally{await client.close();await server.close();await new Promise<void>(resolve=>core.close(()=>resolve()));}
});
