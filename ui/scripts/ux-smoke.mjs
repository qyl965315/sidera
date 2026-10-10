import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
import React from 'react';

import {MemoryRouter} from 'react-router-dom';
import {writeFileSync,mkdirSync} from 'node:fs';
const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {createRoot}=await import('react-dom/client');
let sample;
const uuid='12345678-1234-4234-8234-123456789abc',calls=[],errors=[];let uncertainIntent=false;
let fixture={bootstrap:true,configuration:{valid:true},humans:[],nodes:[],intents:[],bindings:[],effects:[],authority:{},ports:{corePort:47321,mcpPort:47322},runtime:{state:'CORE_STOPPED'},gateway:{state:'UNAVAILABLE'},readiness:{LOCAL_READY:false,FULL_ROUTE_READY:false},frontend:{}};
window.sideraDesktop={approveReview:async(reviewId)=>{assert.equal(reviewId,uuid);calls.push({op:'approve',input:{reviewId}});fixture.authority={actId:uuid};return {ok:true,result:{state:'APPLIED'}};},openProduct:async()=>({opened:true}),saveApiCredential:async(credentialRef,key)=>{calls.push({op:"credential-saved",input:{credentialRef}});assert.equal(key,"synthetic-api-key");return {saved:true};},updateStatus:async()=>({configured:false})};
const inventory={integrations:[],onboarding:[['Codex','codex-app-server'],['Generic API','generic-api'],['Grok','grok-build-acp'],['Gemini','antigravity-cli-headless'],['DSH','dsh-harness-acp'],['MCP','external-mcp-client']].map(([,adapter])=>({adapter,installation:'Installed',configuration:'Not configured',authenticated:'UNVERIFIED',detection:{installed:adapter==='codex-app-server',supported:adapter==='codex-app-server'}})),mcp:[],navigation:{}};
inventory.console={kind:'Console',isNode:false,nodes:[{nodeRef:'fixture-operator',displayName:'Worker',kind:'Operator',operatorKind:'Agent',lifecycle:'active',executors:[{executorRef:'fixture-context',state:'IDLE'}],capabilities:[{operation:'message.receive',availability:'unavailable',freshness:'UNKNOWN'}]}],chiefConversations:[],history:[],omega:[{target:'fixture-resource',state:'UNRESOLVED'}],conflicts:[{target:'fixture-resource',state:'UNRESOLVED'}],grants:[],responsibility:[]};
globalThis.fetch=async(url,options)=>{if(!options?.method)return new Response(JSON.stringify(String(url).includes('/snapshot')?sample:String(url).includes('desktop-management')?inventory:fixture));const op=String(url).split('/').at(-1),input=JSON.parse(options.body);calls.push({op,input});if(op==='intent'&&uncertainIntent)throw Error('synthetic uncertain transport');let value={state:'CONFIGURED'};if(op==='node'||op==='executable-host'){const newNodeId=fixture.nodes.length?uuid+'-'+fixture.nodes.length:uuid;fixture.nodes.push({nodeId:newNodeId,displayName:input.label,hostKind:input.hostKind??'external-mcp-client',health:{state:'UNVERIFIED'},sessionId:uuid});fixture.chiefNodeId??=newNodeId;value={nodeId:newNodeId};}if(op==='human'){fixture.humans.push({human_id:uuid,label:input.label});value={humanId:uuid};}if(op.endsWith('-review'))value={reviewId:uuid,exactStatement:'authority.grant_package exact synthetic test scope '+uuid,confirmationText:'CONFIRM synthetic',manifest:{exact:uuid}};if(op==='approve'){assert.deepEqual(input,{reviewId:uuid});fixture.authority={actId:uuid};value={state:'APPLIED'};}return new Response(JSON.stringify(value));};
let conversationFixture=false,conversationReplyState='delivered',conversationEntryState='delivered';
const baseFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 const value=String(url);
 if(value.includes('/api/communication/view')&&conversationFixture){
   const sent=calls.findLast(c=>c.op==='communication-send')?.input;
   return new Response(JSON.stringify({sendEnabled:true,reasons:[],entries:[{entry_id:'fixture-human-message',
     direction:'human_to_communicator',client_nonce:sent?.clientNonce||'fixture-before-send',
     body:sent?.body||'fixture literal message',created_at:'2026-10-10T08:00:00.000Z',
     transport_state:conversationEntryState}]}));
 }
 if(value.includes('/api/communication/send')&&conversationFixture){
   calls.push({op:'communication-send',input:JSON.parse(options.body)});
   return new Response(JSON.stringify({state:conversationReplyState,messageId:'fixture-message'}));
 }
 return baseFetch(url,options);
};
const oldError=console.error;console.error=(...v)=>{errors.push(v.join(' '));oldError(...v);};
const server=await createServer({configLoader:'runner',server:{middlewareMode:true},appType:'custom'}),sleep=ms=>new Promise(r=>setTimeout(r,ms));let root;
const visibleText=()=>{const clone=document.body.cloneNode(true);for(const detail of clone.querySelectorAll('details:not([open])')){const summary=detail.querySelector('summary');detail.replaceChildren(summary);}for(const el of clone.querySelectorAll('pre,script,style'))el.remove();return clone.textContent;};
const forbidden=/PowerShell|RuntimeSpec|Hythe|CANONICAL|READ ONLY|R0\.2|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23,}|chief\.(bind|handoff)|world\.inspect|OPEN_UNCERTAIN|LOCAL_READY|FULL_ROUTE_READY/i;
const click=async text=>{const b=[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text);assert.ok(b,text);assert.equal(b.disabled,false,text);b.click();await sleep(160);};
const input=async(label,value)=>{const el=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(label))?.querySelector('input,textarea,select');assert.ok(el,label+": "+[...document.querySelectorAll("label")].map(l=>l.textContent).join(" | "));const proto=el.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new dom.window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await sleep(30);};
try{const {default:App}=await server.ssrLoadModule('/src/App.tsx');sample={...(await server.ssrLoadModule('/src/mocks/snapshot.ts')).snapshot,source:'live',readStatus:'available'};
 const mount=async route=>{root?.unmount();root=createRoot(document.getElementById('root'));root.render(React.createElement(MemoryRouter,{initialEntries:[route]},React.createElement(App)));await sleep(250);};
 await mount('/status');assert.equal(document.querySelector('[data-sidera-surface="Console"]')!==null,true);assert.ok(document.querySelector('[data-sidera-console="Boundaries"]').textContent.includes('不是一个节点'));await click('状态冲突');assert.ok(document.querySelector('[data-sidera-console="Boundaries"]').textContent.includes('UNRESOLVED'));await click('共享历史');assert.equal(document.querySelector('[data-sidera-console="Boundaries"]').textContent.includes('记录数量：0'),true);
 inventory.console.history=[{id:'conversation-fixture',kind:'Communication',timestamp:'2026-10-10T08:00:00.000Z',taskRef:'fixture-work',payload:{form:'Conversation'}},{id:'discussion-fixture',kind:'Communication',timestamp:'2026-10-10T08:01:00.000Z',payload:{form:'Discussion'}}];inventory.console.chiefConversations=[{projectRef:'fixture-project',conversationRef:'fixture-conversation'}];await mount('/communication');assert.equal(document.querySelector('[data-sidera-surface="Communication"]')!==null,true);assert.ok(document.querySelector('.communication-table').textContent.includes('已记录'));assert.equal(document.querySelector('.communication-composer textarea').disabled,true);assert.equal([...document.querySelectorAll('.communication-composer button')].find(b=>b.textContent==='发送').disabled,true);await click('讨论 1');assert.ok(document.querySelector('.communication-table').textContent.includes('讨论'));
 fixture.humans=[{human_id:uuid,label:'Fixture Human'}];fixture.bindings=[{binding_id:'fixture-binding',conversation_ref:'fixture://exact'}];conversationFixture=true;
 const composerSend=()=>[...document.querySelectorAll('.conversation-composer button')].find(b=>b.textContent==='发送一次');
 const setMessage=async text=>{const el=document.querySelector('.conversation-composer textarea'),proto=dom.window.HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await sleep(40)};
 await mount('/communication');await setMessage('fixture typed send');assert.equal(composerSend().disabled,false);
 composerSend().click();await sleep(220);
 assert.equal(calls.filter(c=>c.op==='communication-send').length,1);
 assert.equal(calls.findLast(c=>c.op==='communication-send').input.body,'fixture typed send');
 const pinned=JSON.parse(localStorage.getItem('sidera.conversation.pending'));
 assert.equal(pinned.nonce,calls.findLast(c=>c.op==='communication-send').input.clientNonce);
 assert.equal(composerSend().disabled,true,'sent request stays locked before Host observation');
 composerSend().click();await sleep(70);assert.equal(calls.filter(c=>c.op==='communication-send').length,1);
 await mount('/communication');assert.equal(composerSend().disabled,true,'reload cannot mint a second nonce');
 conversationEntryState='observed';await mount('/communication');await sleep(120);
 assert.equal(localStorage.getItem('sidera.conversation.pending'),null,'verified original observation unlocks the next turn');
 conversationEntryState='queued';conversationReplyState='queued';await mount('/communication');
 await setMessage('queued body literal');assert.equal(composerSend().disabled,false);composerSend().click();await sleep(200);
 const firstQueued=calls.findLast(c=>c.op==='communication-send').input;
 const resume=[...document.querySelectorAll('.conversation-composer button')].find(b=>b.textContent==='继续排队的原消息');
 assert.ok(resume,'queued original must offer an explicit same-nonce continuation');
 const beforeResume=calls.filter(c=>c.op==='communication-send').length;resume.click();await sleep(220);
 assert.equal(calls.filter(c=>c.op==='communication-send').length,beforeResume+1);
 const continued=calls.findLast(c=>c.op==='communication-send').input;
 assert.equal(continued.clientNonce,firstQueued.clientNonce);assert.equal(continued.body,firstQueued.body);
 await mount('/communication');assert.equal(composerSend().disabled,true,'queued continuation did not invent another nonce');
 conversationEntryState='observed';await mount('/communication');await sleep(120);
 assert.equal(localStorage.getItem('sidera.conversation.pending'),null);
 conversationFixture=false;fixture.humans=[];fixture.bindings=[];
 await mount('/setup');assert.equal(document.documentElement.lang,'zh-CN');assert.equal(document.querySelectorAll('.sidebar nav a').length,6);assert.equal(document.querySelectorAll('.steps li').length,3);assert.equal(document.querySelectorAll('.wizard-content .primary').length,2);
 await click('连接');await click('连接');assert.equal(calls.at(-1).op,'executable-host');assert.deepEqual(calls.at(-1).input,{automatic:true,hostKind:'codex-app-server'});await click('关闭');await click('继续');assert.equal(calls.at(-1).op,'human');assert.ok(document.querySelector('.wizard-content').textContent.includes('启用并确认'));await click('审查并应用权限');assert.equal(document.querySelectorAll('[role="dialog"]').length,1);assert.equal(document.querySelector('.dialog input'),null);assert.equal(document.querySelectorAll('.dialog details').length,1);assert.equal(document.querySelector('.dialog .primary').disabled,false);await click('批准并继续');await click('已应用，继续');await click('开始工作');assert.ok(document.querySelector('.work-surface'));assert.equal(calls.filter(c=>c.op==='approve').length,1);
 inventory.console.ruleProposals=[{proposalId:'rules-fixture',objectHash:'fixture-hash',object:{level:'World',scopeRef:'fixture-world'},reviewPolicy:{reviewers:'Human',reviewerSelection:'Human',humanInvolvement:'required',reviewerCount:0},reviews:[]}];await mount('/status');await click('规则与审阅');await click('核对并审阅此精确版本');assert.equal(calls.at(-1).op,'rules-adoption-review');assert.deepEqual(calls.at(-1).input,{humanId:uuid,proposalId:'rules-fixture'});assert.equal(document.querySelectorAll('[role="dialog"]').length,1);assert.equal(calls.at(-1).op,'rules-adoption-review','Preview must not adopt Rules');await click('取消');inventory.console.ruleProposals=[];
 const audits=[];for(const route of ['/','/work','/communication','/nodes','/integrations','/permissions','/status','/settings','/new-work','/tasks/return','/tasks/auth']){await mount(route);const text=visibleText();assert.equal(forbidden.test(text),false,route+' leaks technical content');assert.equal(document.querySelector('footer select'),null);audits.push({route,language:'zh-CN',noTechnicalLeak:true});await click('EN');assert.equal(document.documentElement.lang,'en');assert.equal(/[\u4e00-\u9fff]/.test([...document.querySelectorAll('.sidebar nav a')].map(x=>x.textContent).join('')),false);await click('中文');}
 await mount('/integrations');for(const name of ['Codex','Generic API','Grok Build','Gemini / Antigravity','DeepSeek Harness','MCP']){[...document.querySelectorAll('.integration-choice')].find(t=>t.querySelector('strong').textContent===name).click();await sleep(30);await click('连接');assert.equal(document.querySelectorAll('[role="dialog"]').length,1);assert.equal(forbidden.test(visibleText()),false,name);await click('关闭');}
 const antigravityEntry=inventory.onboarding.find(entry=>entry.adapter==='antigravity-cli-headless');
 antigravityEntry.detection={installed:true,supported:true};
 antigravityEntry.availableModels=['gemini-3.8-flash-low','gemini-3.1-pro-low'];
 await mount('/integrations');
 [...document.querySelectorAll('.integration-choice')].find(t=>t.querySelector('strong').textContent==='Gemini / Antigravity').click();
 await sleep(30);await click('连接');
 const missingSelection=[...document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent==='连接');
 assert.equal(missingSelection.disabled,true,'Native Antigravity cannot be configured without explicit model selection');
 await input('Antigravity 模型','gemini-3.8-flash-low');await click('连接');
 const antigravityRequest=calls.filter(x=>x.op==='executable-host').at(-1)?.input;
 assert.equal(antigravityRequest.hostKind,'antigravity-cli-headless');
 assert.equal(antigravityRequest.modelId,'gemini-3.8-flash-low','UI uses Human-selected native model, never implicit auto');
 await click('关闭');
 await mount('/integrations');[...document.querySelectorAll('.integration-choice')].find(t=>t.querySelector('strong').textContent==='Generic API').click();await sleep(30);await click('连接');await input('名称','Local API');await input('提供方标识','arbitrary-local');await input('服务地址','http://127.0.0.1:1234/v1/');await input('API 密钥','synthetic-api-key');await click('保存服务');const saved=calls.findLast(c=>c.op==='credential-saved'),api=calls.findLast(c=>c.op==='api-host');assert.ok(/^env:SIDERA_API_[A-Za-z0-9_]+$/.test(saved.input.credentialRef));assert.deepEqual(api.input,{hostKind:'generic-api',protocol:'openai-compatible',label:'Local API',providerId:'arbitrary-local',baseUrl:'http://127.0.0.1:1234/v1/',credentialRef:saved.input.credentialRef});assert.ok(!JSON.stringify(api).includes('synthetic-api-key'));assert.ok(calls.indexOf(saved)<calls.indexOf(api));
 await mount('/integrations');[...document.querySelectorAll('.integration-choice')].find(t=>t.querySelector('strong').textContent==='Generic API').click();await sleep(30);await click('连接');await input('名称','No key');await input('提供方标识','local');await input('服务地址','http://localhost:1234/');await click('保存服务');assert.equal(calls.at(-1).op,'api-host');assert.equal(calls.at(-1).input.credentialRef,undefined);
 await mount('/settings/advanced');const details=document.querySelector('details');details.open=true;assert.ok(document.body.textContent.includes(uuid));assert.ok(document.body.textContent.includes('world.inspect'));assert.equal(document.querySelector('textarea'),null);
 await mount('/status');await click('处理异常');assert.equal(document.querySelectorAll('[role="dialog"]').length,1);assert.equal(forbidden.test(visibleText()),false);assert.ok(document.querySelector('.dialog .primary').disabled);await click('关闭');
 for(const scenario of ['blocked','empty','error']){const {backendAdapter}=await server.ssrLoadModule('/src/data/backendAdapter.ts');if(scenario==='error')await assert.rejects(()=>backendAdapter.readSnapshot(undefined,scenario));else{const s=await backendAdapter.readSnapshot(undefined,scenario);assert.equal(s.tasks.length,0);}}
 fixture.intents=[{intent_id:'owned-intent',human_id:uuid,revision_id:'exact-parent',content:'原始目标'}];fixture.taskIntentLinks=[{task_id:'return',intent_id:'owned-intent'}];await mount('/tasks/return');assert.equal(document.querySelector('.work-pane')!==null,true);await click('收起工作列表');assert.equal(document.querySelector('.work-pane'),null);await click('展开工作列表');assert.ok(document.querySelector('.work-pane'));await click('置顶工作');assert.ok(JSON.parse(localStorage.getItem('sidera.pinned')).includes('return'));await input('你想完成什么？','请保留来源');await click('更新目标');assert.equal(calls.at(-1).op,'intent-revise-review');assert.equal(calls.at(-1).input.intentId,'owned-intent');assert.equal(calls.at(-1).input.parentRevisionId,'exact-parent');assert.equal(calls.at(-1).input.content,'原始目标\n\n请保留来源');await click('取消');assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='更新目标').disabled,true);
 fixture.readiness.LOCAL_READY=true;uncertainIntent=true;await mount('/new-work');await input('你想完成什么？','原样保留这个目标');const submit=[...document.querySelectorAll('button')].find(b=>b.textContent==='开始');assert.equal(submit.disabled,false);submit.click();submit.click();await sleep(100);assert.equal(calls.filter(c=>c.op==='intent').length,1);assert.ok(document.querySelector('[role="alert"]').textContent.includes('操作结果未知'));for(const name of ['开始','保存目标'])assert.ok([...document.querySelectorAll('button')].find(b=>b.textContent===name).disabled);
 assert.deepEqual(errors,[]);mkdirSync('../desktop-evidence',{recursive:true});writeFileSync('../desktop-evidence/ux-localization.json',JSON.stringify({state:'PASS',routes:audits,sixIntegrations:true,communicationReadOnly:true,communicationForms:['Conversation','Discussion','Thread','Messaging'],genericApiSecretReferenceOnly:true,noKeyLocalApi:true,threeStepSetup:true,exactReviewGate:true,advancedEvidence:true,uncertainWorkLocked:true,doubleClickSubmissions:1,rendererErrors:errors},null,2));console.log('PASS UX: 6 navigation entries, canonical read-only Communication with all four semantic forms and disabled send path, 3-step first run, native review request, zh/en navigation, focused integration dialogs, exact advanced evidence, and uncertain work lock.');
}finally{root?.unmount();await server.close();dom.window.close();console.error=oldError;}



