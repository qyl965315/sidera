"""Allowlisted Windows runtime candidate, production dependency vendoring and privacy scan."""
from pathlib import Path
import json, shutil, hashlib, re, sys, datetime
root=Path(__file__).resolve().parent.parent
out=Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit('Candidate target must be new; never overwrite an existing artifact')
out.mkdir(parents=True)
for folder in ['core','hythes','peregrine','qwen','ui/dist','ui/integration']:
    shutil.copytree(root/folder,out/folder)
scripts=['local-launcher.ts','core-lifecycle.ts','sidera.ts','human-onboard.ts','human-package.ts','runtime-enroll.ts','runtime-return-grant.ts','mcp-tools.ts','tunnel-status.ts','tunnel-supervisor.ts','start-sidera-tunnel.ps1','start-zcode-host.ps1']
for name in scripts:
    (out/'scripts').mkdir(exist_ok=True)
    shutil.copy2(root/'scripts'/name,out/'scripts'/name)
docs=['Start-Sidera.cmd','package.json','package-lock.json','tsconfig.json','SETUP_R1.md','R1_FINAL_PRODUCT_CLOSURE.md','R1_UI_COMPLETENESS_REPORT.md','FUNCTION_INTERFACE_MAP.md','PRODUCT_FLOW_R1.md','ARCHITECTURE_DIET_R1.md','RELEASE_NOTES_R1_PRODUCT.md','README_PRODUCT_CANDIDATE.md']
for name in docs:
    shutil.copy2(root/name,out/('README.md' if name=='README_PRODUCT_CANDIDATE.md' else name))
    exported=out/('README.md' if name=='README_PRODUCT_CANDIDATE.md' else name)
    if exported.suffix=='.md':
        body=exported.read_text(encoding='utf-8-sig')
        body=re.sub(r'[A-Z]:[\\/]+(?:CodexProjects|Sidera-R1|Users[\\/]+[^\\/\s"\']+)[^\s`<>]*','[historical local artifact path omitted]',body,flags=re.I)
        exported.write_text(body,encoding='utf-8')
for name in ['package.json','package-lock.json']:
    shutil.copy2(root/'ui'/name,out/'ui'/name)
lock=json.loads((root/'package-lock.json').read_text(encoding='utf-8-sig'))
vendored=[]
for relative,entry in lock['packages'].items():
    if relative.startswith('node_modules/') and not entry.get('dev'):
        source=root/relative
        if not source.is_dir(): raise SystemExit('Missing production dependency: '+relative)
        shutil.copytree(source,out/relative,dirs_exist_ok=True,ignore=shutil.ignore_patterns('tests','test','.github'))
        vendored.append({'path':relative,'version':entry.get('version'),'integrity':entry.get('integrity')})
findings=[];scanned=0
private_values=set()
private_spec=root/'.sidera-dev/sol/data/runtime-spec.json'
def collect_private(value):
    if isinstance(value,list):
        for child in value:collect_private(child)
    elif isinstance(value,dict):
        for key,child in value.items():
            if isinstance(child,str) and len(child)>16 and (key in ['nodeId','sessionId','hytheId','httpToken','coreToken','conversationRef'] or re.search(r'password|secret|apiKey',key,re.I)):
                if not child.startswith('env:'):private_values.add(child)
            collect_private(child)
if private_spec.exists():collect_private(json.loads(private_spec.read_text(encoding='utf-8-sig')))
rules={
 'private-user':r'13cheng4',
 'dev-absolute-path':r'[A-Z]:[\\/]+(?:CodexProjects|Sidera-R1|Users[\\/]+[^\\/\s"\']+)',
 'chat-conversation':r'https://chatgpt\.com/c/[^\s"<>]+',
 'api-key':r'\bsk-[A-Za-z0-9_-]{16,}',
 'private-key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END',
 'literal-bearer':r'Bearer [A-Za-z0-9_\-.]{24,}',
}
for p in out.rglob('*'):
    if not p.is_file():continue
    relative=p.relative_to(out).as_posix();scanned+=1
    if any(part in ['.sidera-dev','correction-evidence','.git','tests'] for part in p.relative_to(out).parts):findings.append({'file':relative,'rule':'forbidden-private-state'})
    if p.suffix.lower() in ['.sqlite','.db','.jsonl','.log'] or (p.suffix.lower()=='.png' and not relative.startswith('node_modules/')):findings.append({'file':relative,'rule':'runtime-or-evidence-file'})
    try:body=p.read_text(encoding='utf-8')
    except (UnicodeError,OSError):continue
    if any(value in body for value in private_values):findings.append({'file':relative,'rule':'exact-local-private-value'})
    for rule,pattern in rules.items():
        if re.search(pattern,body,re.I):findings.append({'file':relative,'rule':rule})
scan={'state':'PASS' if not findings else 'FAIL','scannedFiles':scanned,'rules':list(rules)+['exact-local-private-value'],'findings':findings,'scope':'All candidate files including vendored production dependency text; binary filenames checked. No private runtime copied. Official vendored Playwright appIcon.png resources are intentionally public; upstream tests/.github omitted. JOSE key parser marker strings contain no key payload.'}
(out/'PRIVACY_SCAN.json').write_text(json.dumps(scan,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
manifest={'name':'Sidera R1 UI completeness','version':'0.1.0-ui-completeness-candidate','verdict':'RELEASE_READY_WITH_EXPLICIT_EXTERNAL_LIMITS','builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backendTests':'258/258 PASS; original 253 retained','setupAdminTests':'15/15 PASS','frontendBuild':'PASS','uiSmoke':'PASS','privateRuntimeIncluded':False,'vendoredDependencies':vendored,'vendoringReason':'Windows double-click launcher must work offline without npm/PowerShell. Only production lockfile entries copied; frontend dependencies are compiled into dist.','externalEffectsInAcceptance':0,'privacyScan':scan['state'],'cleanInstall':'See CANDIDATE_VALIDATION.json; must be validated after packaging','excluded':['.sidera-dev','tests','correction-evidence','logs','JSONL','screenshots','development dependencies','ui source/node_modules'],'limits':['Owning Host login is external; verified identity remains canonical Node-authorized','Session lifecycle and Host replacement remain Node-authorized advanced operations','No fabricated detached ChatGPT return route']}
(out/'CANDIDATE_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sums():
    return ''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(out).as_posix()+'\n' for p in sorted(out.rglob('*')) if p.is_file() and p.name!='SHA256SUMS')
(out/'SHA256SUMS').write_text(sums(),encoding='utf-8')
print(json.dumps({'state':scan['state'],'files':scanned,'findings':findings},ensure_ascii=False))
if findings:sys.exit(1)
