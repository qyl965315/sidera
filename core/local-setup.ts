/** Trusted local Human ingress. Not registered in RPC, MCP or any Node tool. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { openDatabase, withTransaction } from './db.ts';
import { createWorld, recordWorld } from './worlds.ts';
import { SemanticStore } from './semantics.ts';
import { canonical, openHumanIngress, explicitHumanStatement, admitHumanAct, type HumanProposal } from './human-admission.ts';
import { bindChiefConversation, handoffChiefConversation } from './chief.ts';
import { requireUniqueLocalConversationHuman } from './conversation.ts';
import { planDevelopmentProfile, type DevelopmentProfileInput } from './development-profile.ts';
import { applyPermissionPackage, materializePermissionPackage, packageActArgs, packageStatus } from './permission-package.ts';
import { uncertainEffects, reconcileEffect } from './effects.ts';
import { checkConfiguration } from './configuration.ts';
import { captureHumanGoal } from './local-human-intent.ts';
import { callCore, hasCoreOwner } from '../hythes/core-client.ts';
import type { RuntimeSpec } from './service.ts';
import { apiHostInput, executableHostInput, routeInput, protocolRoute } from './host-setup.ts';
import { revokePermissionPackage, packageRevokeActArgs, PACKAGE_REVOKE_ACT_TYPE } from './permission-package.ts';
import { renameNode } from './identity.ts';
import {asarText,detectInstalled} from './installed-detection.ts';
import { defaultFrontendRegistry } from '../hythes/frontend-factory.ts';
import {readSessionHostCondition} from './condition.ts';
import { adoptRules, getRuleProposal, reviewPolicyFor } from './rules.ts';

export class SetupError extends Error { code:string; constructor(code:string){super(code);this.code=code;} }
const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const label=z.string().trim().min(1).max(160);
export const setupInputs={
  human:z.object({label}).strict(),
  rename:z.object({humanId:id,nodeId:id,expectedDisplayName:label,displayName:label}).strict(),
  config:z.object({corePort:z.number().int().min(1024).max(65535),mcpPort:z.number().int().min(1024).max(65535)}).strict(),
  provision:z.object({humanId:id,actId:id}).strict(),
  node:z.object({label,edgeId:id,locator:z.string().min(1).max(2048).regex(/^external-mcp:\/\/[^\s]+$/)}).strict(),
  chief:z.object({humanId:id,projectSpaceId:id,projectRef:z.string().min(1).max(2048),frontendKind:id,conversationRef:z.string().min(1).max(2048),expectedBindingId:id.optional()}).strict(),
  profile:z.object({humanId:id,mode:z.enum(['read-only','workspace','full-access'])}).strict(),
  confirm:z.object({reviewId:z.string().uuid(),confirmation:z.string().max(100)}).strict(),
  intent:z.object({humanId:id,body:z.string().min(1).max(65536),submit:z.boolean()}).strict(),
  conversation:z.object({humanId:id,bindingId:id,clientNonce:z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),body:z.string().min(1).max(12000)}).strict(),
  conversationView:z.object({humanId:id,bindingId:id}).strict(),
  reconcile:z.object({humanId:id,effectId:z.string().min(1).max(200),state:z.enum(['OPEN_UNCERTAIN','OBSERVED_COMPLETED','OBSERVED_NOT_APPLIED','SUPERSEDED','HUMAN_ADJUDICATED']),reason:z.string().min(1).max(2000),evidenceEventIds:z.array(id).min(1).max(30),expectedRevision:z.number().int().min(0)}).strict(),
};
type Review={humanId:string;worldId:string;epoch:number;fingerprint:string;proposal:HumanProposal;apply:(proof:{id:string;actId?:string},db:ReturnType<LocalSetup['db']>)=>unknown;confirmation:string;expires:number};
export class LocalSetup {
 readonly root:string; readonly data:string; private reviews=new Map<string,Review>();
 constructor(root:string){this.root=resolve(root);this.data=join(this.root,'.sidera-dev/sol/data');}
 specPath(){return join(this.data,'runtime-spec.json');}
 spec():RuntimeSpec{return JSON.parse(readFileSync(this.specPath(),'utf8'));}
 db(){return openDatabase(join(this.data,'sidera.sqlite'));}
 writeSpec(spec:RuntimeSpec){writeFileSync(this.specPath()+'.tmp',JSON.stringify(spec,null,2)+'\n',{mode:0o600});renameSync(this.specPath()+'.tmp',this.specPath());}
 bootstrap(){
  mkdirSync(this.data,{recursive:true});
  if(!existsSync(this.specPath()))writeFileSync(this.specPath(),JSON.stringify({version:1,corePort:47321,mcpPort:47322,httpToken:randomUUID(),chiefNodeId:'',nodes:[],frontend:{routes:[]}},null,2),{flag:'wx',mode:0o600});
  const db=this.db();try{
   const state=join(this.data,'setup-world.json');
   if(!existsSync(state)){
    const spec=this.spec();const worldId=spec.nodes.length?recordWorld(db,'nodes',spec.chiefNodeId):createWorld(db,'Local Sidera R1','Local launcher bootstrap; no Human, Grant, Host or Presence created');
    writeFileSync(state,JSON.stringify({worldId}),{flag:'wx',mode:0o600});
   }
  }finally{db.close();}
 }
 world(){return String(JSON.parse(readFileSync(join(this.data,'setup-world.json'),'utf8')).worldId);}
 fingerprint(){const hash=createHash('sha256').update(readFileSync(this.specPath()));const file=join(this.data,'mcp-integrations.json');if(existsSync(file))hash.update(readFileSync(file));return hash.digest('hex');}
 human(db:ReturnType<LocalSetup['db']>,humanId:string){if(!db.prepare('SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?').get(this.world(),humanId))throw new SetupError('HUMAN_NOT_IN_WORLD');}
 async status(){const spec=this.spec(),db=this.db();try{
  let runtime:unknown={state:'CORE_STOPPED'},chief:unknown={available:false,core:{state:'CORE_UNAVAILABLE'},reasons:['CORE_UNAVAILABLE']};
  if(spec.nodes.length){try{runtime=await this.invoke('runtime.status',{});}catch{runtime={state:'CORE_UNAVAILABLE'};}try{chief=await this.invoke('chief.status',{});}catch{/* No route is inferred from transport readiness. */}}
  let gateway={state:'UNAVAILABLE',meaning:'transport only'};try{const r=await fetch(`http://127.0.0.1:${spec.mcpPort}/healthz`,{signal:AbortSignal.timeout(1500)});gateway={state:r.ok?'REACHABLE':'UNAVAILABLE',meaning:'transport only; not Human return readiness'};}catch{}
  return {worldId:this.world(),bootstrap:true,configuration:spec.nodes.length?checkConfiguration(spec):{valid:false,errors:['ADD_NODE_REQUIRED'],warnings:['RETURN_ROUTE_UNAVAILABLE']},
   humans:db.prepare('SELECT h.human_id,h.label FROM human_principals h JOIN world_humans w USING(human_id) WHERE w.world_id=?').all(this.world()),
   intents:db.prepare('SELECT i.intent_id,i.human_id,r.revision_id,r.content FROM intents i JOIN intent_revisions r USING(intent_id) WHERE i.world_id=? AND NOT EXISTS(SELECT 1 FROM intent_revisions c WHERE c.parent_revision_id=r.revision_id)').all(this.world()),
   taskIntentLinks:db.prepare('SELECT b.task_id,r.intent_id FROM task_bases b JOIN intent_revisions r ON r.revision_id=b.intent_revision_id AND r.world_id=b.world_id WHERE b.world_id=?').all(this.world()),
   nodes:spec.nodes.map(n=>({nodeId:n.nodeId,displayName:db.prepare('SELECT display_name FROM nodes WHERE node_id=?').get(n.nodeId)?.display_name??n.displayName,hostKind:n.hostKind,sessionId:n.sessionId,hytheId:n.hytheId,locatorRef:n.locatorRef,configured:true,authenticated:'UNVERIFIED',presence:'UNVERIFIED',health:readSessionHostCondition(db,n.sessionId)})),
   bindings:db.prepare("SELECT binding_id,project_space_id,frontend_kind,conversation_ref FROM chief_conversations WHERE chief_node_id=? AND state='active'").all(spec.chiefNodeId),
   chiefNodeId:spec.chiefNodeId,ports:{corePort:spec.corePort,mcpPort:spec.mcpPort},runtime,chief,gateway,authority:packageStatus(db,this.world(),'r1-ui-profile'),effects:uncertainEffects(db).filter(e=>e.actorNodeId&&recordWorld(db,'nodes',e.actorNodeId)===this.world()),
   build:{version:'0.1.0',product:'Sidera R1 UI completeness candidate',identity:(runtime as Record<string,unknown>).build??'UNVERIFIED'},
   readiness:{LOCAL_READY:(runtime as {ready?:boolean}).ready===true,FULL_ROUTE_READY:(runtime as {ready?:boolean}).ready===true&&(chief as {available?:boolean}).available===true},
   frontend:{state:'LOCAL_UI_AVAILABLE',meaning:'Binding != Presence != return route',adapters:defaultFrontendRegistry().adapters(),routes:(spec.frontend?.routes??[]).map(r=>({id:r.id,adapter:r.adapter,configured:true,verified:false})),nativeAvailable:existsSync(process.env.SIDERA_CODEX_APP_TOOLS_SERVER??'')&&Boolean(process.env.CODEX_THREAD_ID)},automaticRetry:false};
 }finally{db.close();}}
 async invoke(method:string,params:Record<string,unknown>){const s=this.spec(),n=s.nodes.find(n=>n.nodeId===s.chiefNodeId);if(!n)throw new SetupError('CHIEF_NODE_REQUIRED');return callCore({port:s.corePort,token:n.coreToken},method,params);}
 async conversationView(value:unknown){
  const p=setupInputs.conversationView.parse(value),s=this.spec();
  try{return await callCore({port:s.corePort,token:s.httpToken},'human.conversation.view',p);}
  catch{return {binding:null,entries:[],sendEnabled:false,reasons:['CORE_OR_TYPED_CONVERSATION_UNAVAILABLE']};}
 }
 async conversationSend(value:unknown){
  const p=setupInputs.conversation.parse(value),s=this.spec(),db=this.db();let utteranceId:string;
  try {this.human(db,p.humanId);
   requireUniqueLocalConversationHuman(db,{humanId:p.humanId,bindingId:p.bindingId});
   const existing=db.prepare(`SELECT utterance_id,body FROM conversation_transcript_entries
     WHERE binding_id=? AND human_id=? AND client_nonce=? AND direction='human_to_communicator'`).get(p.bindingId,p.humanId,p.clientNonce) as {utterance_id:string;body:string}|undefined;
   if(existing){if(existing.body!==p.body)throw new SetupError('CONVERSATION_NONCE_CONFLICT');utteranceId=existing.utterance_id;}
   else {
    const sourceRef=`local-human-desktop:conversation:${p.bindingId}:${p.clientNonce}`;
    const ingress=openHumanIngress(db,{worldId:this.world(),humanId:p.humanId,presenceRef:'local-human-desktop:conversation',sourceRef});
    utteranceId=ingress.capture(p.clientNonce,p.body);
   }
  } finally {db.close();}
  try{return await callCore({port:s.corePort,token:s.httpToken},'human.conversation.send',{...p,utteranceId});}
  catch(error){return {state:'UNCERTAIN',code:'CONVERSATION_RESPONSE_UNCERTAIN',automaticReplay:false,
    next:'Inspect the original Conversation transcript before any new message. The original nonce is retained; no automatic replay occurred.'};}
 }
 async createHuman(value:unknown){const p=setupInputs.human.parse(value),db=this.db();try{return {humanId:new SemanticStore(db,this.world()).createHuman(p.label,'Human declared through local same-origin Setup UI; no provider identity inferred'),authorityGranted:false};}finally{db.close();}}
 async configure(value:unknown){const p=setupInputs.config.parse(value),s=this.spec();if(p.corePort===p.mcpPort||[p.corePort,p.mcpPort].includes(47320))throw new SetupError('PORT_CONFLICT');if(await hasCoreOwner(s.corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');this.writeSpec({...s,...p});return {state:'CONFIG_SAVED',restartRequired:true,authorityGranted:false};}
 provision(value:unknown){const p=setupInputs.provision.parse(value),db=this.db();try{this.human(db,p.humanId);return materializePermissionPackage(db,{worldId:this.world(),humanId:p.humanId,packageActId:p.actId});}finally{db.close();}}
 async addNode(value:unknown){const p=setupInputs.node.parse(value),s=this.spec();if(await hasCoreOwner(s.corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');const db=this.db();try{
  const nodeId=new SemanticStore(db,this.world()).registerNode(p.label),sessionId=randomUUID(),hytheId=randomUUID();
  s.nodes.push({nodeId,sessionId,hytheId,displayName:p.label,hostKind:'external-mcp-client',locatorRef:p.locator,options:{edgeId:p.edgeId},coreToken:randomUUID(),recoverLostSession:false});
  if(!s.chiefNodeId)s.chiefNodeId=nodeId;this.writeSpec(s);return {nodeId,sessionId,hytheId,connected:false,authorityGranted:false,restartRequired:true};
 }finally{db.close();}}
 async addApiHost(value:unknown){
  const p=apiHostInput.parse(value),s=this.spec();if(await hasCoreOwner(s.corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');
  const db=this.db();try{const nodeId=new SemanticStore(db,this.world()).registerNode(p.label),sessionId=randomUUID(),hytheId=randomUUID();
   s.nodes.push({nodeId,sessionId,hytheId,displayName:p.label,hostKind:p.hostKind,locatorRef:`api://${nodeId}/${sessionId}`,coreToken:randomUUID(),recoverLostSession:false,
    options:{protocol:p.protocol,provider:{protocol:p.protocol,providerId:p.providerId,baseUrl:p.baseUrl,...(p.credentialRef?{credentialRef:p.credentialRef}:{})}}});
   if(!s.chiefNodeId)s.chiefNodeId=nodeId;this.writeSpec(s);return {nodeId,sessionId,state:'CONFIGURED',authenticated:false,presence:false,modelBinding:'Requires canonical verified identity enrollment; configuration cannot create it',automaticRetry:false};
  }finally{db.close();}
 }
 async addExecutableHost(value:unknown){
  if((value as Record<string,unknown>)?.automatic===true){
   const p=z.object({automatic:z.literal(true),hostKind:z.enum(['codex-app-server','dsh-harness-acp','grok-build-acp','antigravity-cli-headless']),workspace:z.string().max(2048).optional()}).strict().parse(value);
   const detected=detectInstalled(p.hostKind);if(!detected.supported)throw new SetupError('SUPPORTED_INSTALLED_HOST_REQUIRED');
   const root=join(process.env.LOCALAPPDATA??this.data,'Sidera','isolated-hosts',randomUUID());
   const workspace=p.workspace||join(root,'workspace');
   const options=p.hostKind==='codex-app-server'?{codexExecutable:detected.executable,home:join(root,'home'),temp:join(root,'temp'),codexHome:join(root,'codex'),model:'auto'}:p.hostKind==='dsh-harness-acp'?{executable:detected.executable,cliEntry:detected.cliEntry,dshHome:join(root,'dsh')}:p.hostKind==='antigravity-cli-headless'?{executable:detected.executable,provider:'unverified',modelId:'auto',effort:'medium',settingsPath:join(root,'settings.json')}:{executable:detected.executable,home:join(root,'home')};
   value={label:p.hostKind==='codex-app-server'?'Codex':p.hostKind==='dsh-harness-acp'?'DeepSeek Harness':p.hostKind==='antigravity-cli-headless'?'Gemini':'Grok',hostKind:p.hostKind,locatorRef:'generated',workspace,...options};
  }
  const {label,hostKind,locatorRef,...options}=executableHostInput.parse(value),s=this.spec();
  if(await hasCoreOwner(s.corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');
  for(const key of ['executable','codexExecutable','cliEntry','sdkPath'])if(key in options&&!(key==='cliEntry'&&hostKind==='dsh-harness-acp'&&String((options as Record<string,unknown>)[key])===detectInstalled(hostKind).cliEntry)&&!existsSync(String((options as Record<string,unknown>)[key])))throw new SetupError('INSTALLED_HOST_FILE_REQUIRED');
  if('home' in options&&'temp' in options&&new Set([options.home,options.temp,options.codexHome,options.workspace]).size!==4)throw new SetupError('ISOLATED_HOST_DIRECTORIES_REQUIRED');
  if(s.nodes.some(n=>n.hostKind===hostKind))throw new SetupError('HOST_REPLACEMENT_REQUIRES_NODE_HANDOFF');
  const db=this.db();try{const nodeId=new SemanticStore(db,this.world()).registerNode(label),sessionId=randomUUID(),hytheId=({'dsh-harness-acp':'dsh-acp','grok-build-acp':'grok-build','antigravity-cli-headless':'antigravity-cli','zcode-native-service':'zcode-service'} as Record<string,string>)[hostKind]??randomUUID();
   const exactLocator=locatorRef==='generated'?`installed://${nodeId}/${sessionId}`:locatorRef;
   for(const key of ['workspace','home','temp','codexHome'])if(key in options)mkdirSync(String((options as Record<string,unknown>)[key]),{recursive:true});
   s.nodes.push({nodeId,sessionId,hytheId,displayName:label,hostKind,locatorRef:exactLocator,coreToken:randomUUID(),recoverLostSession:false,options:{...options,mcpEntry:join(this.root,'hythes/node-mcp-entry.ts')}});
   if(!s.chiefNodeId)s.chiefNodeId=nodeId;this.writeSpec(s);
   return {nodeId,sessionId,state:'CONFIGURED',authenticated:false,presence:false,automaticRetry:false,next:'Authenticate in the owning installed Host, then Refresh. Verified model enrollment requires canonical Node identity operations.'};
  }finally{db.close();}
 }
 revoke(value:unknown){
  const p=z.object({humanId:id,packageActId:id,reason:z.string().trim().min(1).max(2000)}).strict().parse(value),db=this.db();
  let scope:string;try{this.human(db,p.humanId);const a=db.prepare('SELECT args_json FROM human_semantic_acts WHERE act_id=? AND world_id=? AND human_id=?').get(p.packageActId,this.world(),p.humanId);if(!a)throw new SetupError('PACKAGE_NOT_OWNED');scope='package/'+JSON.parse(String(a.args_json)).packageId;}finally{db.close();}
  const args=packageRevokeActArgs({...p,requestId:randomUUID()});
  return this.review(p.humanId,{type:PACKAGE_REVOKE_ACT_TYPE,objectRef:p.packageActId,scope,targetRevision:null,args,causalRefs:['local-human-browser:revoke-review']},(proof,db)=>revokePermissionPackage(db,{worldId:this.world(),humanId:p.humanId,...args,revokeActId:proof.actId!}));
 }
 revise(value:unknown){
  const p=z.object({humanId:id,intentId:id,parentRevisionId:id,content:z.string().min(1).max(65536)}).strict().parse(value);
  const db=this.db();try{this.human(db,p.humanId);const intent=db.prepare('SELECT human_id FROM intents WHERE intent_id=? AND world_id=?').get(p.intentId,this.world());if(intent?.human_id!==p.humanId)throw new SetupError('INTENT_NOT_OWNED');}finally{db.close();}
  const args={intentId:p.intentId,parentRevisionId:p.parentRevisionId,content:p.content,sourceRef:'local-human-browser:revision:'+randomUUID()};
  return this.review(p.humanId,{type:'intent.revise',objectRef:p.intentId,scope:'intent/'+p.intentId,targetRevision:p.parentRevisionId,args,causalRefs:[p.parentRevisionId]},(proof,db)=>{
   const store=new SemanticStore(db,this.world()),current=store.currentIntent(p.intentId);
   if(current.state!=='CURRENT'||current.candidates[0]?.revision_id!==p.parentRevisionId)throw new SetupError('INTENT_REVISION_CHANGED');
   return {intentRevisionId:store.reviseIntent(p.intentId,p.parentRevisionId,p.content,args.sourceRef,proof),taskCreated:false,automaticRetry:false};
  });
 }
 async configureRoute(value:unknown){
  const p=routeInput.parse(value),s=this.spec();if(await hasCoreOwner(s.corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');
  const db=this.db();try{const b=db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND chief_node_id=? AND state='active'").get(p.bindingId,s.chiefNodeId);
   if(!b)throw new SetupError('BINDING_CHANGED');const route=protocolRoute(p,b as Parameters<typeof protocolRoute>[1]);
   const routes=s.frontend?.routes??[];if(routes.some(r=>r.id===route.id))throw new SetupError('ROUTE_ALREADY_CONFIGURED_USE_ADVANCED_REPLACEMENT');
   this.writeSpec({...s,frontend:{routes:[...routes,route]}});return {state:'CONFIGURED',authenticated:false,reachable:false,presence:false,restartRequired:true};
  }finally{db.close();}
 }
 async configureNative(value:unknown){
  const p=z.object({bindingId:id}).strict().parse(value),s=this.spec();if(await hasCoreOwner(s.corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');
  const server=process.env.SIDERA_CODEX_APP_TOOLS_SERVER;if(!server||!existsSync(server)||!process.env.CODEX_THREAD_ID)throw new SetupError('REAL_NATIVE_BRIDGE_CONTEXT_REQUIRED');
  const db=this.db();try{const b=db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND chief_node_id=? AND state='active'").get(p.bindingId,s.chiefNodeId);
   if(!b||b.frontend_kind!=='chatgpt-web')throw new SetupError('BINDING_CHANGED');const routes=s.frontend?.routes??[];
   if(routes.some(r=>r.id==='native:'+p.bindingId))throw new SetupError('ROUTE_ALREADY_CONFIGURED_USE_ADVANCED_REPLACEMENT');
   this.writeSpec({...s,frontend:{routes:[...routes,{id:'native:'+p.bindingId,adapter:'codex-app-tools',frontendKind:'chatgpt-web',bindings:[{bindingId:p.bindingId,projectSpaceId:String(b.project_space_id),conversationRef:String(b.conversation_ref)}],options:{nativeServerPath:server}}]}});
   return {state:'CONFIGURED',verified:false,presence:false,restartRequired:true};
  }finally{db.close();}
 }
 rename(value:unknown){const {humanId,...p}=setupInputs.rename.parse(value),db=this.db();try{if(recordWorld(db,'nodes',p.nodeId)!==this.world())throw new SetupError('NODE_NOT_IN_WORLD');}finally{db.close();}
  const input={...p,requestId:randomUUID()};return this.review(humanId,{type:'node.rename',objectRef:p.nodeId,scope:`node/${p.nodeId}`,targetRevision:null,args:input,causalRefs:['local-human-browser:rename-review']},(proof,db)=>renameNode(db,{kind:'human',...proof},input));
 }
 rulesAdoption(value:unknown){
  const p=z.object({humanId:id,proposalId:id,reviewTaskId:id.optional(),reviewTaskIds:z.array(id).optional()}).strict().parse(value),db=this.db();
   if(p.reviewTaskId!==undefined&&p.reviewTaskIds!==undefined){db.close();throw new SetupError('AMBIGUOUS_REVIEW_TASK_IDS');}
  let source:ReturnType<typeof getRuleProposal>;
  try{this.human(db,p.humanId);source=getRuleProposal(db,p.proposalId);
   if(source.object.worldId!==this.world())throw new SetupError('RULE_PROPOSAL_NOT_IN_WORLD');
    const policy=reviewPolicyFor(db,source.object.level,source.object.parentVersionId,source.object.governanceVersionId).policy;
    if(policy.humanInvolvement==='none')throw new SetupError('HUMAN_ADOPTION_NOT_REQUIRED_BY_POLICY');
  }finally{db.close();}
  const args={proposalId:p.proposalId,...(p.reviewTaskId?{reviewTaskId:p.reviewTaskId}:{}),...(p.reviewTaskIds?{reviewTaskIds:p.reviewTaskIds}:{})};
  const review=this.review(p.humanId,{type:'rules.adopt',objectRef:p.proposalId,scope:`rules/${source.object.level}/${source.object.scopeRef}`,targetRevision:null,args,
   causalRefs:[p.proposalId,`RuleProposalSHA256:${source.objectHash}`,`exact-rule-object:${canonical(source.object)}`,...(p.reviewTaskIds??(p.reviewTaskId?[p.reviewTaskId]:[]))]},(proof,db)=>{
    const current=getRuleProposal(db,p.proposalId);
    if(current.object.worldId!==this.world()||current.objectHash!==source.objectHash)throw new SetupError('RULE_PROPOSAL_CHANGED');
    return adoptRules(db,{kind:'human',...proof},args);
   });
  return {...review,ruleProposal:source,adopted:false};
 }
 review(humanId:string,proposal:HumanProposal,apply:Review['apply']){
  const db=this.db();try{this.human(db,humanId);const reviewId=randomUUID(),digest=createHash('sha256').update(canonical(proposal)).digest('hex');
   const confirmation='CONFIRM '+digest.slice(0,16);this.reviews.set(reviewId,{humanId,worldId:this.world(),epoch:Number(db.prepare('SELECT epoch FROM trust_policy WHERE world_id=?').get(this.world())!.epoch),fingerprint:this.fingerprint(),proposal,apply,confirmation,expires:Date.now()+600000});
   const summaries:Record<string,{zh:string;en:string}>={
    'authority.grant_package':{zh:'允许已添加的服务在你选择的范围内查看或协作。此设置不授予文件访问；详细权限逐项列出。',en:'Allow added services to view or collaborate within your selected scope. This profile grants no filesystem access; every permission is listed in the details.'},
    'node.rename':{zh:'修改服务的显示名称，保留工作和历史记录。',en:'Change the service display name while preserving work and history.'},
    'rules.adopt':{zh:'审阅并采纳这一个精确规则版本；原有版本和审查来源保留，不扩大上级边界。',en:'Adopt this exact reviewed Rules object while preserving prior versions and its parent boundary.'},
    'chief.bind':{zh:'将已有对话设为主对话；不创建对话，也不确认登录或结果送达。',en:'Set an existing chat as the main chat without creating a chat or verifying sign-in or delivery.'},
    'chief.handoff':{zh:'切换主对话，保留原对话记录；结果送达仍需单独确认。',en:'Switch the main chat while preserving the old record; result delivery still requires separate verification.'},
    'intent.revise':{zh:'保存你修改后的目标，保留原目标及其来源；不会重放已有操作。',en:'Save your revised goal and preserve its original provenance without replaying operations.'},
    'effect.adjudicate':{zh:'按你提交的来源证据记录核对结论，不重复执行原操作。',en:'Record your reconciliation using submitted evidence without repeating the original operation.'}
   };
   return {reviewId,digest,summary:summaries[proposal.type]??{zh:'按详细内容更改你选择的设置。',en:'Change your selected settings exactly as detailed.'},exactStatement:explicitHumanStatement(proposal),scope:proposal.scope,args:proposal.args,confirmationText:confirmation,authorityGranted:false};
  }finally{db.close();}
 }
 profile(value:unknown){const p=setupInputs.profile.parse(value),s=this.spec();
  const db=this.db();let revision:number;try{revision=Number(db.prepare("SELECT coalesce(max(json_extract(args_json,'$.revision')),0)+1 revision FROM human_semantic_acts WHERE world_id=? AND object_ref='r1-ui-profile'").get(this.world())!.revision);}finally{db.close();}
  const input:DevelopmentProfileInput={worldId:this.world(),packageId:'r1-ui-profile',revision,mode:p.mode,subjects:s.nodes.map(n=>({nodeId:n.nodeId,collaboratorNodeIds:s.nodes.map(n=>n.nodeId),workspaces:[],productionWorkspaceAccess:'none'}))};
  const plan=planDevelopmentProfile(input),manifest=plan.manifest;
  const proposal:HumanProposal={type:'authority.grant_package',objectRef:manifest.packageId,scope:'package/'+manifest.packageId,targetRevision:null,args:packageActArgs(manifest) as unknown as Record<string,unknown>,causalRefs:['local-human-browser:permission-review']};
  return {...this.review(p.humanId,proposal,(proof,db)=>{applyPermissionPackage(db,proof,manifest);return materializePermissionPackage(db,{worldId:this.world(),humanId:p.humanId,packageActId:proof.actId!});}),mode:p.mode,limits:plan.limits,manifest};
 }
 chief(value:unknown){const p=setupInputs.chief.parse(value),s=this.spec();
  const db=this.db();let old:Record<string,unknown>|undefined;try{old=p.expectedBindingId?db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND state='active'").get(p.expectedBindingId):undefined;if(p.expectedBindingId&&!old)throw new SetupError('BINDING_CHANGED');}finally{db.close();}
  const input=p.expectedBindingId?{requestId:randomUUID(),expectedBindingId:p.expectedBindingId,conversationRef:p.conversationRef,frontendKind:p.frontendKind}:{projectSpaceId:p.projectSpaceId,projectRef:p.projectRef,chiefNodeId:s.chiefNodeId,frontendKind:p.frontendKind,conversationRef:p.conversationRef};
  const proposal:HumanProposal={type:p.expectedBindingId?'chief.handoff':'chief.bind',objectRef:p.expectedBindingId??s.chiefNodeId,scope:String(old?.project_space_id??p.projectSpaceId),targetRevision:null,args:input,causalRefs:['local-human-browser:chief-review']};
  return this.review(p.humanId,proposal,(proof,db)=>p.expectedBindingId?handoffChiefConversation(db,{kind:'human',...proof},input as Parameters<typeof handoffChiefConversation>[2]):bindChiefConversation(db,{kind:'human',...proof},input as Parameters<typeof bindChiefConversation>[2]));
 }
 reconciliation(value:unknown){const p=setupInputs.reconcile.parse(value),{humanId,...input}=p,db=this.db();let resource:string;try{const e=uncertainEffects(db).find(e=>e.effectId===p.effectId);if(!e?.actorNodeId||recordWorld(db,'nodes',e.actorNodeId)!==this.world())throw new SetupError('EFFECT_NOT_IN_WORLD');resource=e.resource;}finally{db.close();}
  return this.review(humanId,{type:'effect.adjudicate',objectRef:p.effectId,scope:resource,targetRevision:null,args:input,causalRefs:p.evidenceEventIds},(proof,db)=>reconcileEffect(db,{kind:'human',...proof},input));
 }
 confirm(value:unknown){const p=setupInputs.confirm.parse(value),r=this.reviews.get(p.reviewId);if(!r)throw new SetupError('REVIEW_NOT_FOUND');if(p.confirmation!==r.confirmation)throw new SetupError('HUMAN_CONFIRMATION_REQUIRED');
  this.reviews.delete(p.reviewId);if(r.expires<Date.now()||r.fingerprint!==this.fingerprint())throw new SetupError('REVIEW_STALE');const db=this.db();try{
   return withTransaction(db,'ui_human_review',()=>{this.human(db,r.humanId);if(Number(db.prepare('SELECT epoch FROM trust_policy WHERE world_id=?').get(r.worldId)!.epoch)!==r.epoch)throw new SetupError('REVIEW_STALE');
    const sourceRef='local-human-browser:'+p.reviewId,ingress=openHumanIngress(db,{worldId:r.worldId,humanId:r.humanId,presenceRef:'local-human-browser:explicit-confirmation',sourceRef});
    const answer=ingress.capture(p.reviewId+':answer',p.confirmation),utteranceId=ingress.capture(p.reviewId+':statement',explicitHumanStatement(r.proposal),answer);
    const proof=admitHumanAct(db,{worldId:r.worldId,humanId:r.humanId,utteranceId,proposal:r.proposal});
    return r.apply(proof,db);
   });
  }finally{db.close();}
 }
  nativeReview(value:unknown){const p=z.object({reviewId:z.string().uuid()}).strict().parse(value),r=this.reviews.get(p.reviewId);if(!r)throw new SetupError('REVIEW_NOT_FOUND');if(r.expires<Date.now()||r.fingerprint!==this.fingerprint())throw new SetupError('REVIEW_STALE');const db=this.db();try{if(Number(db.prepare('SELECT epoch FROM trust_policy WHERE world_id=?').get(r.worldId)!.epoch)!==r.epoch)throw new SetupError('REVIEW_STALE');}finally{db.close();}return {statement:explicitHumanStatement(r.proposal),apply:()=>this.confirm({reviewId:p.reviewId,confirmation:r.confirmation})};}
  reviewStatement(value:unknown){const p=setupInputs.confirm.parse(value),r=this.reviews.get(p.reviewId);if(!r||p.confirmation!==r.confirmation)throw new SetupError('HUMAN_CONFIRMATION_REQUIRED');return explicitHumanStatement(r.proposal);}
  applyConfirmed(value:unknown){return this.confirm(value);}
 async intent(value:unknown){const p=setupInputs.intent.parse(value);const db=this.db();try{this.human(db,p.humanId);}finally{db.close();}
  const captured=captureHumanGoal(this.root,p.body,p.humanId,this.world());if(!p.submit)return captured.admission;
  // Read the canonical Chief admission before creating a work request. This local UI is not a return route.
  try{const status=await this.invoke('chief.status',{}) as {available?:boolean;reasons?:unknown};if(status.available!==true)return {state:'blocked',code:'RETURN_ROUTE_UNAVAILABLE',reasons:status.reasons,admission:captured.admission,taskCreated:false,automaticRetry:false};}
  catch{return {state:'blocked',code:'CHIEF_STATUS_UNAVAILABLE',admission:captured.admission,taskCreated:false,automaticRetry:false};}
  const requestId=randomUUID(),receipt=join(this.data,'human-request-'+requestId+'.json'),params={requestId,goal:p.body,basis:{intentRevisionId:captured.admission.intentRevisionId,contextBasis:captured.admission.contextBasis}};
  writeFileSync(receipt,JSON.stringify({state:'intent',params,admission:captured.admission}),{flag:'wx',mode:0o600});
  try{const result=await this.invoke('cooperation.start',params);writeFileSync(receipt+'.response',JSON.stringify({state:'response_received',result}),{flag:'wx',mode:0o600});return {requestId,result,automaticRetry:false};}
  catch(error){const rejected=/Sidera (denied|conflict|not_found|invalid_argument):/.test(String(error)),state=rejected?'rejected':'uncertain';writeFileSync(receipt+'.response',JSON.stringify({state}),{flag:'wx',mode:0o600});return {requestId,state,code:rejected?'WORK_REJECTED':'WORK_UNCERTAIN',automaticRetry:false,next:'Inspect original request and canonical work; never resubmit uncertain work'};}
 }
}
