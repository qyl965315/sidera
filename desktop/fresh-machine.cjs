// Developer/validation harness; no PowerShell required on the validation machine.
// Run with the bundled portable resources/node.exe. Installer target is isolated.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const folder=path.resolve(process.argv[2]||path.join(__dirname,'../candidates/desktop-phase2'));
const installer=path.join(folder,'Sidera-0.1.0-phase2-x64-setup.exe');
const install=path.join(folder,'validation-install');
assert.ok(install.startsWith(folder+path.sep));assert.ok(fs.existsSync(installer));
function run(exe,args){return new Promise((ok,no)=>{const p=spawn(exe,args,{shell:false,windowsHide:true,stdio:'inherit'});p.once('error',no);p.once('exit',code=>code===0?ok():no(Error('INSTALLER_EXIT_'+code)));});}
(async()=>{if(fs.existsSync(install))throw Error('VALIDATION_INSTALL_MUST_BE_FRESH');await run(installer,['/S','/D='+install]);assert.ok(fs.existsSync(path.join(install,'Sidera.exe')));assert.ok(fs.existsSync(path.join(install,'resources/node.exe')));fs.writeFileSync(path.join(folder,'fresh-install-result.json'),JSON.stringify({state:'INSTALLED',target:install,installer:'unsigned',freshOSVerified:false,next:'Launch Sidera, verify Setup and Integrations, export diagnostics, safely quit; validate uninstall/data preservation separately.'},null,2));console.log('Installed to '+install+'. Launch Sidera.exe to finish the UI acceptance checklist.');})().catch(e=>{console.error(e.message);process.exitCode=1;});
