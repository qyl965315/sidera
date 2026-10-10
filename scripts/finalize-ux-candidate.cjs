const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const candidate = path.join(root, 'candidates/desktop-ux-20261006');
const portable = path.join(candidate, 'portable');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2)+'\n', 'utf8');
const files = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);
function sums(dir) {
  const target = path.join(dir,'SHA256SUMS');
  const list = files(dir).filter(p => p !== target).sort();
  fs.writeFileSync(target,list.map(p => hash(p)+'  '+path.relative(dir,p).replaceAll('\\','/')).join('\n')+'\n');
  for (const line of fs.readFileSync(target,'utf8').trim().split('\n')) {
    const [expected, rel] = line.split('  ');
    if (hash(path.join(dir,rel)) !== expected) throw new Error('Hash mismatch: '+rel);
  }
  return list.length;
}
const docs = ['R1_DESKTOP_UX_REDESIGN_REPORT.md','UI_ACTION_MAP.md','LOCALIZATION_AUDIT.md'];
if (process.argv[2] === 'prepare') {
  for (const name of docs) {fs.copyFileSync(path.join(root,name),path.join(candidate,name));fs.copyFileSync(path.join(root,name),path.join(portable,name));}
  const manifestPath = path.join(portable,'DESKTOP_CANDIDATE_MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.verdict='UX_RELEASE_READY_WITH_LIMITS';
  manifest.validation={backendTests:'266/266 PASS',desktopTests:'13/13 PASS',uiBuild:'PASS',uxSmoke:'PASS',localizationPairs:390,visualScreenshots:18,packagedSmoke:'PASS'};
  manifest.published=false;
  manifest.limits=['Unsigned; Electron default icon','Same-machine isolated profile; no fresh OS/VM or installer execution','External authentication/model/return path not verified','Native approval, active turn and updater use explicit test fixtures','GLM/DSH installation contract unavailable','Static pre-render startup is Chinese'];
  manifest.finalizedAt=new Date().toISOString();
  write(manifestPath,manifest);
  fs.writeFileSync(path.join(portable,'README.txt'),'Sidera Desktop UX candidate\nVerdict: UX_RELEASE_READY_WITH_LIMITS. Unpublished and unsigned.\nDouble-click Sidera.exe; retain every adjacent resource.\nSee R1_DESKTOP_UX_REDESIGN_REPORT.md for validation and limitations.\nNo third-party authentication or real message return path is certified.\n');
  console.log(JSON.stringify({portableHashFiles:sums(portable),verdict:manifest.verdict}));
} else if (process.argv[2] === 'finish') {
  const debug=path.join(candidate,'builder-debug.yml');
  if(fs.existsSync(debug))fs.renameSync(debug,path.join(root,'desktop-evidence/ux/installer-builder-debug.yml'));
  const installer=path.join(candidate,'Sidera-0.1.0-ux-x64-setup.exe');
  write(path.join(candidate,'UX_CANDIDATE_MANIFEST.json'),{product:'Sidera Desktop UX',version:'0.1.0',verdict:'UX_RELEASE_READY_WITH_LIMITS',published:false,installerExecuted:false,signature:'NotSigned',installer:{file:path.basename(installer),bytes:fs.statSync(installer).size,sha256:hash(installer)},validation:JSON.parse(fs.readFileSync(path.join(portable,'DESKTOP_CANDIDATE_MANIFEST.json'))).validation,limits:JSON.parse(fs.readFileSync(path.join(portable,'DESKTOP_CANDIDATE_MANIFEST.json'))).limits,finalizedAt:new Date().toISOString()});
  fs.copyFileSync(path.join(portable,'README.txt'),path.join(candidate,'README.txt'));
  const packagedUi=path.join(portable,'resources/backend/ui/dist');
  for(const f of files(path.join(root,'ui/dist')))if(hash(f)!==hash(path.join(packagedUi,path.relative(path.join(root,'ui/dist'),f))))throw new Error('Packaged UI mismatch');
  const privacy=[];
  for(const p of files(portable)) {
    const rel=path.relative(portable,p);
    if(/(^|[\\/])\.sidera-dev([\\/]|$)|\.(sqlite|sqlite3|db|jsonl|log)$/i.test(rel))privacy.push(rel);
    if(/\.(json|md|txt|html|js|cjs|css|yml)$/i.test(p) && /13cheng4|D:\\Sidera-R1-v0\.1\.0/.test(fs.readFileSync(p,'utf8')))privacy.push(rel+': machine path');
  }
  if(privacy.length)throw new Error('Privacy findings: '+privacy.join(', '));
  const result={state:'PASS',privacyFindings:privacy,packagedUiMatchesBuild:true,portableHashFiles:sums(portable),candidateHashFiles:sums(candidate),installerSha256:hash(installer),published:false};
  write(path.join(root,'desktop-evidence/ux/candidate-verification.json'),result);
  console.log(JSON.stringify(result));
} else throw new Error('Use prepare or finish');
