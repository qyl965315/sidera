import { existsSync, readdirSync, realpathSync, lstatSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSpec } from "./service.ts";
import { appendHistory } from "./history.ts";

interface BinaryProof { publisher:string; sha256:string; version:string }
export interface PinRecovery { executable?:string; proof?:BinaryProof; reason:string }
const normalized=(p:string)=>resolve(p).toLowerCase();
function signedCodex(file:string):BinaryProof|null {
  const hash=()=>createHash("sha256").update(readFileSync(file)).digest("hex"),before=hash();
  const literal="'"+file.replaceAll("'","''")+"'";
  const script="$s=Get-AuthenticodeSignature -LiteralPath "+literal+"; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress";
  const checked=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],
    {windowsHide:true,timeout:10_000,maxBuffer:128*1024,encoding:"utf8"});
  if(checked.status!==0)return null;
  let signer:{status:string;subject:string};try{signer=JSON.parse(checked.stdout);}catch{return null;}
  if(signer.status!=="Valid"||!/(?:^|,\s*)O="?OpenAI OpCo,\s*LLC"?(?:,|$)/i.test(signer.subject))return null;
  const version=spawnSync(file,["--version"],{windowsHide:true,timeout:5000,maxBuffer:128*1024,encoding:"utf8",
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP}});
  if(version.status!==0||!/^codex-cli \d+\.\d+\.\d+[^\r\n]*[\r\n]*$/.test(version.stdout)||before!==hash())return null;
  return {publisher:signer.subject,sha256:before,version:version.stdout.trim()};
}
/** Only the owning Windows installation's one signed successor can repair a missing updater slot. */
export function recoverCodexPin(pinned:string,options:{platform?:string;localAppData?:string;verify?:(file:string)=>BinaryProof|null}={}):PinRecovery {
  if(existsSync(pinned))return {reason:"Pinned executable still exists; no substitution"};
  const local=options.localAppData??process.env.LOCALAPPDATA;
  if((options.platform??process.platform)!=="win32"||!local)return {reason:"Owning product installation cannot be verified"};
  const bin=resolve(local,"OpenAI","Codex","bin");
  if(normalized(dirname(dirname(pinned)))!==normalized(bin)||basename(pinned).toLowerCase()!=="codex.exe"||
    !/^[a-f0-9]{16}$/i.test(basename(dirname(pinned))))return {reason:"Missing pin is not an owning-product updater slot"};
  try {
    if(normalized(realpathSync(bin))!==normalized(bin))return {reason:"Owning product bin redirects outside its declared installation"};
    const slots=readdirSync(bin,{withFileTypes:true});
    if(slots.length>32)return {reason:"Ambiguous owning-product updater inventory"};
    const candidates=slots.filter(e=>e.isDirectory()&&/^[a-f0-9]{16}$/i.test(e.name)).map(e=>join(bin,e.name,"codex.exe"))
      .filter(f=>existsSync(f)&&!lstatSync(dirname(f)).isSymbolicLink()&&!lstatSync(f).isSymbolicLink()&&
        lstatSync(f).isFile()&&normalized(realpathSync(f))===normalized(f));
    if(candidates.length!==1)return {reason:"A unique installed successor is required"};
    const file=candidates[0]!,proof=(options.verify??signedCodex)(file);
    if(!proof)return {reason:"Installed successor lacks valid OpenAI signature or Codex CLI identity"};
    return {executable:file,proof,reason:"Verified owning-product update"};
  }catch{return {reason:"Owning product successor could not be verified"};}
}
/** Local infrastructure repair, scoped to the executable field. No account, locator, Node or Grant changes. */
export function repairCodexPins(db:DatabaseSync,spec:RuntimeSpec,specPath:string,expectedText:string):void {
  const changes:Array<{nodeId:string;oldPath:string;newPath:string;proof:BinaryProof}>=[];
  for(const node of spec.nodes){
    if(node.hostKind!=="codex-app-server"||typeof node.options?.codexExecutable!=="string")continue;
    const oldPath=node.options.codexExecutable,recovery=recoverCodexPin(oldPath);
    if(recovery.executable&&recovery.proof){node.options.codexExecutable=recovery.executable;
      changes.push({nodeId:node.nodeId,oldPath,newPath:recovery.executable,proof:recovery.proof});}
  }
  if(!changes.length)return;
  if(readFileSync(specPath,"utf8")!==expectedText)throw Error("RuntimeSpec changed during executable repair; no overwrite");
  const temporary=specPath+"."+randomUUID()+".tmp",fd=openSync(temporary,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(spec,null,2)+"\n");fsyncSync(fd);}finally{closeSync(fd);}
  // The second guard also fences a configuration edit made while verification/fsync ran.
  if(readFileSync(specPath,"utf8")!==expectedText)throw Error("RuntimeSpec changed before executable publication; no overwrite");
  renameSync(temporary,specPath);
  for(const change of changes){
    const id=randomUUID(),at=new Date().toISOString();
    db.prepare("INSERT INTO events VALUES (?,?,'host.executable.repinned',?,?)").run(id,change.nodeId,
      JSON.stringify({...change,source:"verified-owning-product-update",accountsChanged:false,locatorsChanged:false}),at);
    appendHistory(db,{id:"host-pin:"+id,kind:"Effect",source:"interface:owning-product-executable-recovery",nodeRef:change.nodeId,
      payload:{operation:"host.executable.repin",...change,accountsChanged:false,locatorsChanged:false,authorityMinted:false}});
  }
}
