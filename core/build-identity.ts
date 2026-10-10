import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join,resolve } from "node:path";

/** Captured once at startup. Queries never ask Git what the process loaded. */
export function captureBuildIdentity(root:string,dbPath:string) {
  const startedAt=new Date().toISOString();
  let sourceCommit:string|null=null,sourceDirty:boolean|null=null,sourceDigest:string|null=null;
  try {
    const git=(args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","ignore"]}).trim();
    sourceCommit=git(["rev-parse","HEAD"]);
    const paths=["core","hythes","peregrine","qwen","package.json","package-lock.json"];
    sourceDirty=Boolean(git(["status","--porcelain","--untracked-files=all","--",...paths]));
    const files=git(["ls-files","--cached","--others","--exclude-standard","--",...paths]).split(/\r?\n/).filter(Boolean).sort();
    const hash=createHash("sha256");for(const file of files)hash.update(file).update(readFileSync(join(root,file)));
    sourceDigest=hash.digest("hex");
  } catch {/* Unknown is explicit; a non-Git installation cannot claim a commit. */}
  if(sourceDigest===null) {
    // Installed source distributions have no Git metadata. A deterministic source
    // digest identifies what this process loaded without inventing a commit.
    try {const files:string[]=[];const walk=(path:string)=>{for(const e of readdirSync(join(root,path),{withFileTypes:true})){
      const relative=path+'/'+e.name;if(e.isDirectory()&&e.name!=='node_modules')walk(relative);else if(e.isFile()&&/\.(?:ts|js|cjs|json)$/.test(e.name))files.push(relative);
    }};for(const folder of ['core','hythes','peregrine','qwen'])if(existsSync(join(root,folder)))walk(folder);
      for(const file of ['package.json','package-lock.json'])if(existsSync(join(root,file)))files.push(file);
      const hash=createHash('sha256');for(const file of files.sort())hash.update(file).update(readFileSync(join(root,file)));sourceDigest=hash.digest('hex');
    }catch{/* Preserve explicit UNKNOWN when the source cannot be read. */}
  }
  return Object.freeze({sourceCommit,loadedCommit:sourceDirty===false?sourceCommit:null,sourceDirty,sourceDigest,
    builtAt:startedAt,startedAt,pid:process.pid,dbPath:resolve(dbPath),schemaVersion:"r1-constitutional-runtime-v1"});
}
export type RuntimeBuildIdentity=ReturnType<typeof captureBuildIdentity>;
