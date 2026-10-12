const {app,BrowserWindow,ipcMain,shell,dialog,Menu,safeStorage,clipboard}=require('electron');
const {spawn}=require('node:child_process');const {join,resolve}=require('node:path');const {mkdirSync,existsSync,appendFileSync,readFileSync}=require('node:fs');const {createServer}=require('node:net');
const {exactChat,trustedSender}=require('./policy.cjs');
const {ApiCredentials,scrubApiEnvironment}=require('./api-credentials.cjs');
const {Updates}=require('./updates.cjs');const {summary}=require('./diagnostics.cjs');
const guides=Object.freeze({'codex-app-server':'https://github.com/openai/codex/blob/main/docs/authentication.md','grok-build-acp':'https://docs.x.ai/build/overview'});
let updateConfiguration=null;try{const configFile=join(app.isPackaged?process.resourcesPath:__dirname,'release-feed.json');if(existsSync(configFile))updateConfiguration=JSON.parse(readFileSync(configFile,'utf8'));}catch{throw Error('INVALID_RELEASE_CONFIG');}
let window,worker,origin,closing=false,quitting=false,serial=0;const requests=new Map(),logs=[];
const assets=app.isPackaged?join(process.resourcesPath,'backend'):resolve(__dirname,'..');
const viewerTarget=process.env.SIDERA_CONSOLE_VIEW_ROOT?resolve(process.env.SIDERA_CONSOLE_VIEW_ROOT):null;
if(viewerTarget&&!process.env.SIDERA_DESKTOP_TEST_DATA){
 const viewerProfile=join(app.getPath('userData'),'console-viewer-profile');
 mkdirSync(viewerProfile,{recursive:true});app.setPath('userData',viewerProfile);
}
const root=process.env.SIDERA_DESKTOP_TEST_DATA?resolve(process.env.SIDERA_DESKTOP_TEST_DATA):join(app.getPath('userData'),'runtime');
const apiCredentials=new ApiCredentials(root,safeStorage);
// Test profiles must not acquire the production desktop's single-instance lock.
if(process.env.SIDERA_DESKTOP_TEST_DATA){const profile=join(root,'electron-profile');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);}
async function localCopy(){let english=false;try{english=await window.webContents.executeJavaScript("document.documentElement.lang === 'en'");}catch{}return (zh,en)=>english?en:zh;}
const updates=new Updates({configuration:updateConfiguration,directory:join(root,'updates'),version:app.getVersion()});
try{const fs=require('node:fs'),file=join(root,'desktop.log'),size=fs.statSync(file).size,fd=fs.openSync(file,'r'),bytes=Buffer.alloc(Math.min(size,32768));try{fs.readSync(fd,bytes,0,bytes.length,Math.max(0,size-bytes.length));logs.push(...bytes.toString('utf8').split('\n').filter(l=>/^\d{4}-\d\d-\d\dT[\d:.Z-]+ [A-Z_]+$/.test(l)).slice(-100));}finally{fs.closeSync(fd);}}catch{}
const log=code=>{if(!/^[A-Z_]+$/.test(code))return;const line=new Date().toISOString()+' '+code;logs.push(line);if(logs.length>100)logs.shift();try{require('node:fs').writeFileSync(join(root,'desktop.log'),logs.join('\n')+'\n');}catch{}};
const startupError=()=>{if(!origin&&window&&!window.isDestroyed())void window.webContents.executeJavaScript("document.querySelector('p').textContent='启动失败，设置界面暂时不可用。请检查应用文件，不会自动重试。'").catch(()=>{});};
function request(type,payload={}){return new Promise((ok,no)=>{if(!worker?.connected)return no(Error('WORKBENCH_UNAVAILABLE'));if(requests.size>=16)return no(Error('DESKTOP_REQUEST_LIMIT'));const id=String(++serial);const timer=setTimeout(()=>{requests.delete(id);no(Error('WORKBENCH_UNCERTAIN'));},type==='approve-review'?65000:15000);requests.set(id,value=>{clearTimeout(timer);ok(value);});worker.send({...payload,type,id});});}
function guard(event){if(!trustedSender(event,window,origin))throw Error('UNTRUSTED_RENDERER');}
async function diagnostics(){let lifecycle=[],integrations=[];try{lifecycle=(await request('diagnostics')).lifecycle;integrations=(await request('summary')).integrations;}catch{}return {version:app.getVersion(),coreVersion:'0.1.0',workbenchVersion:'0.1.0',electron:process.versions.electron,node:'bundled Node 24',dataDirectory:root,workbench:worker?.connected?'CONNECTED':'UNAVAILABLE',logs:[...logs,...lifecycle].sort().slice(-100),integrations,updates:updates.status(),automaticRetry:false};}
async function quit(){if(closing||quitting)return;if(!worker&&!origin){quitting=true;app.quit();return;}closing=true;try{const result=await request('quit');if(!result.closed){log(result.code);const c=await localCopy();await dialog.showMessageBox(window,{type:'warning',message:c('Sidera 保持打开','Sidera remains open'),detail:c('有活动工作，或停止结果未知。请在状态页核对后安全停止，运行服务已保留。','Active work or uncertain shutdown blocks exit. Inspect Status, then stop safely. The runtime is preserved.')});return;}quitting=true;app.quit();}catch{const c=await localCopy();await dialog.showMessageBox(window,{type:'warning',message:c('退出结果无法确认','Exit could not be verified'),detail:c('为保留运行服务，应用保持打开。请查看状态页和高级诊断。','The app stays open to preserve runtime ownership. Inspect Status and Advanced diagnostics.')});}finally{closing=false;}}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{window?.show();window?.focus();});
 app.on('before-quit',event=>{if(!worker&&!origin)quitting=true;if(worker&&!quitting){event.preventDefault();void quit();}});
 app.whenReady().then(async()=>{
  mkdirSync(root,{recursive:true});log('DESKTOP_START');
  if(!viewerTarget)try{apiCredentials.load(process.env);}catch{log('CREDENTIAL_UNAVAILABLE');}
  const appIcon=app.isPackaged?join(__dirname,'sidera.png'):join(__dirname,'assets','sidera.png');
  window=new BrowserWindow({width:1280,height:850,show:false,title:'Sidera',icon:appIcon,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webviewTag:false,devTools:!app.isPackaged}});
  window.on('close',event=>{if(!quitting){event.preventDefault();void quit();}});window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!origin||new URL(url).origin!==origin)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  Menu.setApplicationMenu(null);
  await window.loadFile(join(__dirname,'startup.html'));window.show();
  try{
   const port=await new Promise((ok,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
   const node=app.isPackaged?join(process.resourcesPath,'node.exe'):process.env.SIDERA_NODE_EXECUTABLE||'C:/Program Files/nodejs/node.exe';
   if(!existsSync(node))throw Error('BUNDLED_NODE_UNAVAILABLE');
   worker=spawn(node,[join(assets,'desktop',viewerTarget?'viewer-worker.ts':'worker.ts')],{cwd:root,windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,SIDERA_API_CREDENTIAL_NAMES:[...apiCredentials.names].join(','),SIDERA_PROJECT_ROOT:root,SIDERA_ASSET_ROOT:assets,SIDERA_DESKTOP_PORT:String(port),SIDERA_CONSOLE_VIEW_ROOT:viewerTarget??undefined}});
   worker.on('error',()=>{log('WORKBENCH_START_FAILED');startupError();});worker.on('exit',()=>{log('WORKBENCH_EXITED_NO_REPLAY');startupError();if(!origin)worker=undefined;});
   worker.on('message',async m=>{
    if(m.type==='ready'){origin=m.address;log('WORKBENCH_READY');await window.loadURL(origin+(viewerTarget?'/projects':m.setupRequired===false?'/':'/first-use'));}
    if(m.type==='response'){requests.get(m.id)?.(m.value);requests.delete(m.id);}
    if(m.type==='human-review'){
     const c=await localCopy();const answer=await dialog.showMessageBox(window,{type:'warning',title:c('确认授权','Authority confirmation'),message:c('批准这次明确操作？','Approve this exact act?'),detail:m.statement,buttons:[c('取消','Cancel'),c('我已审查，批准','I reviewed and approve')],defaultId:0,cancelId:0,noLink:true});
     if(worker.connected)worker.send({type:'human-answer',id:m.id,approved:answer.response===1});
    }
   });
   setTimeout(()=>{if(!origin){log('STARTUP_UNAVAILABLE_NO_RETRY');startupError();}},15000).unref();
  }catch{log('STARTUP_FAILED_NO_RETRY');startupError();}
 });
 ipcMain.handle('desktop:approve-review',async(event,reviewId)=>{guard(event);if(typeof reviewId!=='string'||! /^[0-9a-f-]{36}$/i.test(reviewId))throw Error('INVALID_REVIEW');return request('approve-review',{reviewId});});
 ipcMain.handle('desktop:save-api-credential',async(event,credentialRef,key)=>{guard(event);if(!worker?.connected)throw Error('LOCAL_CREDENTIAL_SAVE_FAILED');try{const result=apiCredentials.save(credentialRef,key,process.env);worker.send({type:'credential',credentialRef,key});return result;}catch{throw Error('LOCAL_CREDENTIAL_SAVE_FAILED');}});
 ipcMain.handle('desktop:open-product',async(event,adapter)=>{guard(event);if(!['codex-app-server','dsh-harness-acp','antigravity-cli-headless'].includes(adapter))throw Error('OWNING_PRODUCT_ACTION_UNAVAILABLE');const found=await request('product-location',{adapter});if(!found.path||!existsSync(found.path))throw Error('OWNING_PRODUCT_ACTION_UNAVAILABLE');
  if(adapter==='codex-app-server'){if(!found.codexHome)throw Error('CONFIGURE_PRODUCT_FIRST');const env={...scrubApiEnvironment(apiCredentials.scrub(process.env),found.apiCredentialNames),CODEX_HOME:found.codexHome};delete env.OPENAI_API_KEY;delete env.DEEPSEEK_API_KEY;const child=spawn(found.path,['login'],{windowsHide:true,env,stdio:['ignore','ignore','ignore']});await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});const timer=setTimeout(()=>child.kill(),300000);timer.unref();child.once('exit',()=>clearTimeout(timer));return {opened:true,authenticated:false};}
  if(adapter==='dsh-harness-acp'){if(!found.dshHome)throw Error('CONFIGURE_PRODUCT_FIRST');const env={...scrubApiEnvironment(apiCredentials.scrub(process.env),found.apiCredentialNames),DSH_HOME:found.dshHome,DSH_TELEMETRY_MODE:'DISABLED'};delete env.DEEPSEEK_API_KEY;delete env.OPENAI_API_KEY;const child=spawn(found.path,[],{windowsHide:true,detached:true,env,stdio:'ignore'});child.on('error',()=>log('OWNING_PRODUCT_OPEN_FAILED'));child.unref();return {opened:true,authenticated:false};}
  const error=await shell.openPath(found.path);if(error)throw Error('OWNING_PRODUCT_ACTION_UNAVAILABLE');return {opened:true,authenticated:false};});
 ipcMain.handle('desktop:diagnostics',async event=>{guard(event);return diagnostics();});
 ipcMain.handle('desktop:copy-report',async(event,text)=>{guard(event);if(typeof text!=='string'||text.length>200000)throw Error('INVALID_REPORT');clipboard.writeText(text);return {copied:true};});
 ipcMain.handle('desktop:export-report',async(event,text)=>{guard(event);if(typeof text!=='string'||text.length>200000)throw Error('INVALID_REPORT');const c=await localCopy(),selected=await dialog.showSaveDialog(window,{title:c('导出工作报告','Export work report'),defaultPath:'Sidera-report.txt',filters:[{name:c('文本报告','Text report'),extensions:['txt']}]});if(selected.canceled)return {exported:false};require('node:fs').writeFileSync(selected.filePath,text,'utf8');return {exported:true};});
 ipcMain.handle('desktop:open-data',async event=>{guard(event);const error=await shell.openPath(root);if(error)throw Error('DATA_FOLDER_UNAVAILABLE');return {opened:true};});
 ipcMain.handle('desktop:export-diagnostics',async event=>{guard(event);const c=await localCopy();const d=summary(await diagnostics());const selected=await dialog.showSaveDialog(window,{title:c('导出已脱敏诊断','Export redacted diagnostics'),defaultPath:'Sidera-diagnostics.json',filters:[{name:c('诊断文件','Diagnostic file'),extensions:['json']}]});if(selected.canceled)return {exported:false};require('node:fs').writeFileSync(selected.filePath,JSON.stringify(d,null,2));return {exported:true};});
 ipcMain.handle('desktop:update-status',async event=>{guard(event);return updates.status();});
 ipcMain.handle('desktop:host-guide',async(event,adapter)=>{guard(event);if(typeof adapter!=='string'||!Object.hasOwn(guides,adapter))throw Error('OWNING_PRODUCT_ACTION_UNAVAILABLE');await shell.openExternal(guides[adapter]);return {opened:true,authenticated:false,presenceChanged:false};});
 ipcMain.handle('desktop:update-check',async event=>{guard(event);return updates.check();});
 ipcMain.handle('desktop:update-download',async event=>{guard(event);return updates.download();});
 ipcMain.handle('desktop:update-install',async event=>{guard(event);if(!app.isPackaged)throw Error('PACKAGED_APP_REQUIRED');const c=await localCopy();const answer=await dialog.showMessageBox(window,{type:'warning',message:c('安装已验证的更新？','Install verified update?'),detail:c('下载完整性已验证，发布者身份尚未验证。安装前必须安全停止 Sidera。','Download integrity is verified; publisher identity is unverified. Sidera must stop safely before installation.'),buttons:[c('取消','Cancel'),c('停止并安装','Stop and install')],defaultId:0,cancelId:0});if(answer.response!==1)return updates.status();if(closing)throw Error('SHUTDOWN_BUSY');closing=true;try{return await updates.install(()=>request('quit'),async file=>{const child=spawn(file,[],{detached:true,windowsHide:false,stdio:'ignore',shell:false});await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});child.unref();quitting=true;app.quit();});}finally{closing=false;}});
 ipcMain.handle('desktop:fallback',async event=>{guard(event);await shell.openExternal(origin+'/setup');return {opened:true};});
 ipcMain.handle('desktop:open-chat',async(event,id)=>{guard(event);if(typeof id!=='string'||id.length>200)throw Error('INVALID_BINDING');const bindings=await request('bindings');const binding=bindings.find(b=>b.binding_id===id);const nav=(await request('navigation'))[id];const uri=binding?.conversation_ref??nav?.userOpenableConversationRef,product=binding?.frontend_kind??nav?.product;if(!exactChat(uri,product))throw Error('EXACT_USER_OPENABLE_URI_UNAVAILABLE');await shell.openExternal(uri);return {opened:true,presenceChanged:false,returnRouteChanged:false};});
}
