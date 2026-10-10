import {projectSupport, INTEGRATION_SUBJECTS} from './evidence-governance.ts';
/** Local Human product metadata; never an identity, Presence, or Authority source. */
import {readFileSync,writeFileSync,renameSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {basename} from 'node:path';
import {executableHostInput} from './host-setup.ts';
import {detectInstalled} from './installed-detection.ts';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {LocalSetup} from './local-setup.ts';
import {SetupError} from './local-setup.ts';
import {hasCoreOwner} from '../hythes/core-client.ts';
import {spawnSync} from 'node:child_process';
import {readHistory,currentOmega} from './history.ts';
import {readNodeOntology,chiefConversationRole} from './ontology.ts';
import {executorPool} from './executors.ts';
import {capabilityTruth} from './capability-truth.ts';
import {getRuleProposal,listRules,reviewPolicyFor} from './rules.ts';
// @ts-expect-error CJS policy is shared with desktop main, never renderer authority.
import policy from '../desktop/policy.cjs';
// @ts-expect-error Shared desktop environment scrubber.
import {scrubApiEnvironment} from '../desktop/api-credentials.cjs';
const text=z.string().min(1).max(200);
const adapters=['codex-app-server','dsh-harness-acp','grok-build-acp','antigravity-cli-headless','generic-api','external-mcp-client'];
export function normalInstalledHost(value:unknown){const p=executableHostInput.parse(value);const file=String('codexExecutable' in p?p.codexExecutable:'executable' in p?p.executable:'');const expected:Record<string,string[]>={'codex-app-server':['codex.exe'],'grok-build-acp':['grok.exe'],'antigravity-cli-headless':['antigravity.exe']};if(!expected[p.hostKind]?.includes(basename(file.replaceAll('\\','/')).toLowerCase()))throw new SetupError('OWNING_PRODUCT_INSTALL_CONTRACT_REQUIRED');return p;}
export class DesktopManagement {
 readonly setup:LocalSetup;
 private signInChecks=new Map<string,{state:string;observedAt:string;fingerprint:string;availableModels?:string[]}>();
 constructor(setup:LocalSetup){this.setup=setup;}
 /** Console is a Human view over Boundaries, never a Node or private Sovereignty reader. */
 consoleProjection(){const db=this.setup.db();try{
   const world=this.setup.world(),history=readHistory(db,{worldRef:world}),omega=currentOmega(db,world);
   const nodes=db.prepare(`SELECT n.node_id,n.display_name,n.lifecycle FROM nodes n JOIN world_records w
     ON w.table_name='nodes' AND w.record_key=json_array(n.node_id) WHERE w.world_id=? ORDER BY n.created_at`).all(world).map(n=>{
       const nodeRef=String(n.node_id),runtime=db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(nodeRef);
       const known=db.prepare("SELECT DISTINCT operation FROM capability_checks WHERE node_ref=?").all(nodeRef).map(c=>String(c.operation));
       return {...readNodeOntology(db,nodeRef),displayName:n.display_name,lifecycle:n.lifecycle,executors:executorPool(db,nodeRef),
         capabilities:[...new Set(['message.receive',...known])].map(op=>capabilityTruth(db,nodeRef,runtime?String(runtime.session_id):null,op))};
     });
   const refs=new Set(nodes.map(n=>n.nodeRef));
   return {kind:'Console',isNode:false,sovereignty:false,worldRef:world,
     nodes,chiefConversations:db.prepare("SELECT project_space_id,chief_node_id FROM chief_conversations WHERE state='active'").all()
       .filter(b=>refs.has(String(b.chief_node_id))).map(b=>chiefConversationRole(db,String(b.project_space_id))),
     history:history.slice(-100),omega,conflicts:omega.filter(x=>x.state==='UNRESOLVED'),
     rules:listRules(db,world),ruleProposals:db.prepare(`SELECT p.proposal_id FROM rule_proposals p
       WHERE p.world_id=? AND NOT EXISTS (SELECT 1 FROM rule_versions v WHERE v.proposal_id=p.proposal_id)
       ORDER BY p.created_at`).all(world).map(p=>{const proposal=getRuleProposal(db,String(p.proposal_id)),
          applicable=reviewPolicyFor(db,proposal.object.level,proposal.object.parentVersionId,proposal.object.governanceVersionId);
          return {...proposal,reviewPolicy:applicable.policy,reviewPolicySource:applicable.source,
            reviews:db.prepare(`SELECT r.task_id,r.reviewer_node_id,t.state FROM machine_rule_reviews r JOIN tasks t USING(task_id)
              WHERE r.proposal_id=? ORDER BY r.task_id`).all(String(p.proposal_id)).map(r=>({...r,reviewerKind:readNodeOntology(db,String(r.reviewer_node_id)).kind}))};}),
     grants:db.prepare("SELECT grant_id,subject_node_id,capability,resource_scope,parent_grant_id,expires_at,revoked_at FROM grants").all().filter(g=>refs.has(String(g.subject_node_id))),
     responsibility:history.filter(h=>['Action','Review','Grant','Revoke','Effect','Consequence','Fork','HumanDecision'].includes(h.kind)).slice(-100)
       .map(h=>({recordRef:h.id,sequence:h.sequence,kind:h.kind,nodeRef:h.nodeRef,taskRef:h.taskRef,projectRef:h.projectRef,parentRecords:h.parentRecords,rulesVersions:h.rulesVersions})),
     readScope:'public-world-history',privateSovereigntyIncluded:false};
 }finally{db.close();}}
 navigation(){try{return JSON.parse(readFileSync(join(this.setup.data,'navigation.json'),'utf8')) as Record<string,{product:string;userOpenableConversationRef:string}>;}catch{return {};}}
 setNavigation(value:unknown){const p=z.object({nodeId:text,product:z.enum(['chatgpt','grok']),userOpenableConversationRef:z.string().max(2048)}).strict().parse(value);if(!this.setup.spec().nodes.some(n=>n.nodeId===p.nodeId)||!policy.exactChat(p.userOpenableConversationRef,p.product))throw new SetupError('EXACT_USER_OPENABLE_URI_UNAVAILABLE');const file=join(this.setup.data,'navigation.json');writeFileSync(file+'.tmp',JSON.stringify({...this.navigation(),[p.nodeId]:{product:p.product,userOpenableConversationRef:p.userOpenableConversationRef}}),{mode:0o600});renameSync(file+'.tmp',file);return {state:'NAVIGATION_SAVED',identityChanged:false,presenceChanged:false};}
 onboarding(){const s=this.setup.spec();return adapters.map(adapter=>{const nodes=s.nodes.filter(n=>n.hostKind===adapter);const files=nodes.map(n=>String(n.options?.codexExecutable??n.options?.executable??n.options?.sdkPath??''));const detection=detectInstalled(adapter);const installed=detection.installed||files.some(f=>existsSync(f)&&statSync(f).isFile());const checked=this.signInChecks.get(adapter);const signIn=checked&&checked.fingerprint===this.setup.fingerprint()?checked.state:'UNVERIFIED';const support=projectSupport({subject:INTEGRATION_SUBJECTS[adapter]!,interfaceSupport:"IMPLEMENTED",machine:{configured:nodes.length>0,configuredExecutableExists:files.some(Boolean)?files.filter(Boolean).every(f=>existsSync(f)):undefined,detectorInstalled:detection.installed,detectorSupported:detection.supported}});return {adapter,detection,support,details:nodes.map(n=>({hostKind:n.hostKind})),installation:adapter.endsWith('-api')||adapter==='external-mcp-client'?'Installed':installed?'Installed':'Not installed',configuration:nodes.length?'Configured':'Not configured',signIn,signInObservedAt:checked?.observedAt,availableModels:checked?.fingerprint===this.setup.fingerprint()?checked.availableModels??[]:[],reachable:'UNVERIFIED',authenticated:'UNVERIFIED',presence:'UNVERIFIED',readiness:support.overall,installAction:'Complete in owning product',loginAction:'Complete in owning product',nodeIds:nodes.map(n=>n.nodeId)};});}
 checkService(value:unknown){const p=z.object({adapter:z.enum(['codex-app-server','dsh-harness-acp','antigravity-cli-headless'])}).strict().parse(value),found=detectInstalled(p.adapter),node=this.setup.spec().nodes.find(n=>n.hostKind===p.adapter);let state='UNVERIFIED',availableModels:string[]=[];if(found.executable&&p.adapter==='codex-app-server'&&node?.options.codexHome){const result=spawnSync(found.executable,['login','status'],{windowsHide:true,timeout:5000,maxBuffer:128*1024,encoding:'utf8',env:{...scrubApiEnvironment(process.env,[...(process.env.SIDERA_API_CREDENTIAL_NAMES??'').split(',').filter(Boolean),...this.setup.spec().nodes.map(n=>(n.options.provider as {credentialRef?:string})?.credentialRef).filter((r):r is string=>typeof r==='string'&&/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(r)).map(r=>r.slice(4))]),CODEX_HOME:String(node.options.codexHome)}});state=result.status===0?'SIGNED_IN_REPORTED':result.status===1?'NEEDS_SIGN_IN':'UNVERIFIED';}if(found.executable&&p.adapter==='antigravity-cli-headless'){const result=spawnSync(found.executable,['models'],{windowsHide:true,timeout:8000,maxBuffer:512*1024,encoding:'utf8',cwd:this.setup.data});state=result.status===0?'SIGNED_IN_REPORTED':/Please sign in|not logged/i.test(result.stdout+result.stderr)?'NEEDS_SIGN_IN':'UNVERIFIED';if(result.status===0)availableModels=result.stdout.split(/\r?\n/).map(line=>line.split(/\s+/)[0]).filter(id=>/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(id)).slice(0,64);}const observedAt=new Date().toISOString();this.signInChecks.set(p.adapter,{state,observedAt,fingerprint:this.setup.fingerprint(),availableModels});return {state,observedAt,availableModels,authenticated:'UNVERIFIED',presence:false,modelWorkSubmitted:0,automaticRetry:false};}
 inventory(){return (this.setup.spec().frontend?.routes??[]).map(r=>({id:r.id,adapter:r.adapter,enabled:r.enabled!==false,actor:'Frontend service '+r.id+'; local Human configuration; no Node authority',transport:r.adapter==='mcp-http'?'MCP Streamable HTTP':'Installed native bridge',endpoint:r.adapter==='mcp-http'?String(r.options.endpoint):undefined,capabilities:Object.keys((r.options.operations??{}) as object),tools:Object.values((r.options.operations??{}) as object),health:'UNVERIFIED',bindings:r.bindings?.map(b=>b.bindingId)}));}
 async change(value:unknown){const p=z.object({id:text,action:z.enum(['enable','disable','remove'])}).strict().parse(value);if(await hasCoreOwner(this.setup.spec().corePort))throw new SetupError('STOP_CORE_BEFORE_CONFIG_CHANGE');const db=this.setup.db();try{if(db.prepare("SELECT 1 FROM task_runs WHERE turn_open=1 OR state IN ('running','queued') LIMIT 1").get()||db.prepare("SELECT 1 FROM tasks WHERE state NOT IN ('completed','cancelled','failed') LIMIT 1").get())throw new SetupError('ACTIVE_WORK_REFERENCES_INTEGRATION');}finally{db.close();}const s=this.setup.spec(),routes=s.frontend?.routes??[];if(!routes.some(r=>r.id===p.id))throw new SetupError('INTEGRATION_NOT_FOUND');this.setup.writeSpec({...s,frontend:{...s.frontend,routes:p.action==='remove'?routes.filter(r=>r.id!==p.id):routes.map(r=>r.id===p.id?{...r,enabled:p.action==='enable'}:r)}});return {state:'CONFIG_SAVED',restartRequired:true};}
 async health(value:unknown){const p=z.object({id:text}).strict().parse(value),r=this.setup.spec().frontend?.routes?.find(r=>r.id===p.id);if(!r||r.adapter!=='mcp-http'||r.enabled===false)throw new SetupError('SUPPORTED_ENABLED_MCP_REQUIRED');const token=process.env[String(r.options.authTokenEnv)];if(!token)return {state:'NEEDS_SIGN_IN',authenticated:false,tools:[]};const client=new Client({name:'sidera-desktop-inspection',version:'0.1.0'});try{const transport=new StreamableHTTPClientTransport(new URL(String(r.options.endpoint)),{requestInit:{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});await client.connect(transport,{timeout:10000});const result=await client.listTools(undefined,{timeout:10000});return {state:'REACHABLE',authenticated:'Endpoint accepted configured credential; publisher identity unverified',tools:result.tools.slice(0,200).map(t=>({name:t.name.slice(0,200)})),presence:false,returnRouteVerified:false};}catch{return {state:'UNAVAILABLE_OR_UNCERTAIN',authenticated:'UNVERIFIED',tools:[],automaticRetry:false};}finally{await client.close().catch(()=>{});}}
}
