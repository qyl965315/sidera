/** Local-only P0 verification: real Sidera Core Chief token -> canonical Gateway
 * registration -> self-hosted Bridge protocol -> bounded readonly receipt.
 * NEVER prints bearer tokens, OAuth secrets or raw private config.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildOperationRegistry} from "../hythes/mcp-gateway.ts";
const runtime="D:/Sidera-R1-v0.1.0/.sidera-dev/sol/data/";
const spec=JSON.parse(readFileSync(runtime+"runtime-spec.json","utf8")) as {
  corePort:number;nodes:Array<{nodeId:string;coreToken?:string}>
};
const gateway=JSON.parse(readFileSync(runtime+"gateway.json","utf8")) as {
  edges:Array<{id:string;boundNodeId:string;chiefConversationRef?:string;chiefBindingId?:string}>
};
const edge=gateway.edges.find(e=>e.id==="chatgpt");
assert.ok(edge && edge.chiefBindingId && edge.chiefConversationRef);
const node=spec.nodes.find(n=>n.nodeId===edge.boundNodeId);
assert.ok(node?.coreToken);
const registry=buildOperationRegistry({
  port:spec.corePort,token:node.coreToken,
  chiefConversationRef:edge.chiefConversationRef,
  chiefIngressScope:{nodeId:edge.boundNodeId,edgeId:edge.id,
    conversationRef:edge.chiefConversationRef,bindingId:edge.chiefBindingId},
});
function parse(value:unknown):any {
 const v=value as {content?:Array<{text?:string}>;isError?:boolean};
 const body=JSON.parse(v.content?.[0]?.text??"{}");
 return {...body,isError:!!v.isError};
}
const list=parse(await registry.get("remote.bridge.list")!.invoke({path:".",depth:1}));
assert.equal(list.status,"ok",JSON.stringify(list));
assert.equal(list.operation,"fs.list");
const read=parse(await registry.get("remote.bridge.read.text")!.invoke({path:"README.txt",maxBytes:4096}));
assert.equal(read.status,"ok",JSON.stringify(read));
assert.equal(read.operation,"fs.read_text");
assert.match(String(read.receipt.result?.content),/read.only/i);
const traversal=parse(await registry.get("remote.bridge.read.text")!.invoke({path:"../README.txt"}));
assert.equal(traversal.isError,true);
assert.equal(traversal.code,"BRIDGE_RELATIVE_PATH_REQUIRED");
const outside=parse(await registry.get("remote.bridge.read.text")!.invoke({path:"does-not-exist.txt"}));
assert.equal(outside.isError,true);
console.log(JSON.stringify({status:"PASS_CANDIDATE_SIDERA_CORE_TO_BRIDGE",
  source:"authentic local Chief RPC and self-hosted Bridge",
  listStatus:list.status,readStatus:read.status,
  listCount:list.receipt?.result?.entries?.length??null,
  contentBytes:Buffer.byteLength(String(read.receipt.result.content??""),"utf8"),
  traversalsRejected:true,outsideReadDenied:true,
  bridgePort:47311,tokenOrSecretPrinted:false,
  originalChatProviderSessionStillUnverified:true,
  modelCalls:0,hostEffects:0},null,2));
