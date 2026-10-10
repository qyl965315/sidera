import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {BASIC_INVARIANTS,R1_GOVERNANCE} from '../core/constitution.ts';
import {isConstitutionalMethod} from '../core/constitutional-rpc.ts';
import {canonicalToolNames} from '../hythes/canonical-mcp.ts';

const read=(path:string)=>readFileSync(path,'utf8');
const rows:Array<{id:string;state:'PASS';scope:string;evidence:string[]}> = [];
function audit(id:string,scope:string,evidence:string[],work:()=>void){work();rows.push({id,state:'PASS',scope,evidence});}
audit('ontology','Current canonical UI, README, Constitution and typed ontology API',['core/ontology.ts','ui/src/ConsolePanel.tsx','README.md','SIDERA_R1_CONSTITUTION.md'],()=>{
 for(const file of ['README.md','SIDERA_R1_CONSTITUTION.md','ui/src/ConsolePanel.tsx','core/ontology.ts'])assert.ok(!/Chief Node|Chief 节点|Frontier/.test(read(file)),file);
 assert.ok(read('core/ontology.ts').includes('Communicator'));assert.equal(R1_GOVERNANCE.consoleIsNode,false);
});
audit('sovereignty-surface','RPC selector denial plus public broker guards; behavior is covered by focused tests',['core/rpc.ts','core/source.ts','peregrine/text.ts','tests/constitutional-sovereignty.test.ts'],()=>{
 assert.match(read('core/rpc.ts'),/method\.startsWith\("subjectivity\."\)/);
 assert.match(read('core/rpc.ts'),/Sovereignty accepts no Node selector/);
 for(const file of ['core/source.ts','peregrine/text.ts'])assert.match(read(file),/assertOutsideSovereignty/);
});
audit('no-generic-world-write','Finite Node RPC surface; no arbitrary History/Delta mutation',['core/constitutional-rpc.ts','hythes/constitutional-mcp.ts'],()=>{
 for(const name of ['omega.apply','omega.set','history.append','world.rules.mutate','basic.rewrite'])assert.equal(isConstitutionalMethod(name),false);
 for(const name of ['history_append','omega_set','subjectivity_get_other','world_rules_adopt'])assert.equal(canonicalToolNames().includes(name),false);
});
audit('claim-not-fact','Only effect kinds admit Delta; no imported subjectivity fields',['core/history.ts','tests/constitutional-history.test.ts'],()=>{
 const s=read('core/history.ts');assert.match(s,/!changeKinds\.has\(input\.kind\)/);
 const kinds=s.match(/const changeKinds = new Set<HistoryKind>\(\[(.*?)\]\)/)![1]!;assert.ok(!kinds.includes('Claim'));
 assert.ok(!s.slice(s.indexOf('const specs:')).includes('"description"'));assert.ok(!s.slice(s.indexOf('const specs:')).includes('"explanation"'));
});
audit('rule-and-grant-enforcement','Implementation anchors plus behavioral tests; not a proof from spelling alone',['core/rules.ts','core/authority.ts','tests/constitutional-authority.test.ts','tests/constitutional-rules.test.ts'],()=>{
 assert.match(read('core/rules.ts'),/assertRuleBoundary\(parentFor\(db,input\),input\.boundary\)/);
 assert.match(read('core/authority.ts'),/parentGrantId/);assert.match(read('core/authority.ts'),/grantEffectiveNow/);
});
audit('basic-scope','No honesty, provider, review-topology, penalty or scheduler policy in Basic constants',['core/constitution.ts'],()=>{
 assert.equal(R1_GOVERNANCE.autonomousRuleEvolution,false);
 assert.ok(!/honest|diversity|punish|penalty|scheduler|round.robin/i.test(BASIC_INVARIANTS.join(' ')));
});
audit('review-topology-policy','Reviewer topology is Rule/bootstrap policy, never a Basic invariant',['core/constitution.ts','core/rules.ts'],()=>{
 assert.ok(!/reviewer|Chief Conversation review|Machine Review \+ Human/i.test(BASIC_INVARIANTS.join(' ')),'reviewer topology must not be Basic');
 const constitution=read('core/constitution.ts');
 assert.match(constitution,/R1_BOOTSTRAP_GOVERNANCE/);assert.match(constitution,/kind: "bootstrap-policy"/);
 assert.match(constitution,/humanInvolvement/);assert.match(constitution,/independentRequired/);assert.match(constitution,/reviewerCount/);
 const rules=read('core/rules.ts');
 assert.match(rules,/reviewPolicyFor\(db,level/);assert.match(rules,/never from this proposal|never from the proposal/);
 assert.ok(!/p\.level==="Task"&&\(!role/.test(rules)&&!/p\.level!=="Task"&&actor\.kind!=="human"/.test(rules),'level-hardcoded reviewer topology must be gone');
});
audit('gateway-registry','Canonical MCP registration is the single operation-registry source',['hythes/mcp-gateway.ts','hythes/tool-catalog.ts'],()=>{
 const gateway=read('hythes/mcp-gateway.ts');
 assert.ok(!gateway.includes('STABLE_OPERATION_GROUPS')&&!gateway.includes('GATEWAY_OPERATIONS'),'no duplicated operation list');
 assert.match(gateway,/buildOperationRegistry/);
 assert.match(read('hythes/tool-catalog.ts'),/canonicalOperationForTool/);
 assert.ok(canonicalToolNames().includes('history_list'),'canonical registration carries the constitutional operations');
});
audit('evidence-secret-markers','Generated evidence files; detects token/private-key forms, not all possible secret formats',['evidence/'],()=>{
 for(const item of readdirSync('evidence',{withFileTypes:true}))if(item.isFile()&&/\.(json|md|txt)$/.test(item.name)){
  const s=read(join('evidence',item.name));assert.ok(!/\bsk-[A-Za-z0-9_-]{18,}|Bearer\s+[A-Za-z0-9_.-]{24,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s),`Secret marker in ${item.name}`);
 }
});
mkdirSync('evidence',{recursive:true});
writeFileSync('evidence/r1-constitutional-static-audit.json',JSON.stringify({schemaVersion:1,mode:'deterministic bounded source audit',checks:rows,
 limitation:'Static guards are complemented by full behavioral suites. This audit does not inspect credentials or claim real external Host E2E.'},null,2)+'\n');
console.log(`Constitution source audit: ${rows.length}/${rows.length} PASS`);
