import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
import React from 'react';
import {MemoryRouter} from 'react-router-dom';
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://127.0.0.1/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,
 localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,
 Event:dom.window.Event,MouseEvent:dom.window.MouseEvent});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {createRoot}=await import('react-dom/client');
let sample;
// Fixture metadata is assigned after the Vite module has loaded.
const calls=[];
let denied=false;
globalThis.fetch=async(url,opts)=>{
 calls.push({url:String(url),method:opts?.method??'GET'});
 if(String(url).includes('/api/r1/snapshot')){
  return new Response(JSON.stringify(denied?{...sample,readStatus:'denied',access:'denied',projects:[],tasks:[],nodes:[],runs:[]}:sample),{status:200});
 }
 if(String(url).includes('/api/setup/status'))return new Response(JSON.stringify({runtime:{ready:true},readiness:{LOCAL_READY:true},nodes:[],bindings:[],humans:[]}),{status:200});
 if(String(url).includes('/api/setup/desktop-management'))return new Response(JSON.stringify({console:{nodes:[],history:[],omega:[]}}),{status:200});
 throw Error('Unexpected fetch '+url);
};
const server=await createServer({configLoader:'runner',server:{middlewareMode:true},appType:'custom'});
const {snapshot}=await server.ssrLoadModule('/src/mocks/snapshot.ts');sample=structuredClone(snapshot);
sample.source='live';sample.readStatus='available';sample.access='authorized';
const {default:App}=await server.ssrLoadModule('/src/App.tsx');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let root;
const mount=async(path)=>{
 root?.unmount();
 document.getElementById('root').textContent='';
 root=createRoot(document.getElementById('root'));
 root.render(React.createElement(MemoryRouter,{initialEntries:[path]},React.createElement(App)));
 await sleep(180);
};
try{
 await mount('/');
 assert.ok(document.querySelector('.sc-shell'),'Console must be the default');
 assert.equal(document.querySelectorAll('.sc-rail nav a').length,2,'Exactly two main navigation entries');
 assert.ok(document.querySelector('.sc-project-layout'));
 assert.ok(!document.querySelector('.work-composer'),'Console must never be another task composer');
 assert.ok(!document.querySelector('.communication-composer'),'No communications entry in main UI');
 assert.ok(!document.body.textContent.includes('Sidera message'),'No protocol messages shown as UI');
 await mount('/projects/r1/tasks/chief');
 assert.ok(document.querySelector('.sc-runs'),'Task detail exposes the Run list');
 const buttons=[...document.querySelectorAll('.sc-run-trigger')];
 assert.equal(buttons.length,2,'Two recorded Runs are visible as two entries');
 buttons[0].click();await sleep(80);
 assert.ok(document.querySelector('.sc-run-details'),'Click expands evidence');
 assert.ok(document.body.textContent.includes('第 1 次执行'));
 await mount('/nodes');
 assert.equal(document.querySelectorAll('.sc-rail nav a').length,2);
 assert.ok(document.querySelector('.sc-node-list'),'Node management is not a separate Integration page');
 assert.ok(document.querySelector('.sc-node-detail'));
 assert.ok(document.body.textContent.includes('Codex'));
 denied=true;await mount('/projects');
 assert.ok(document.querySelector('.sc-unavailable'),'Denied canonical read must not be replaced by sample data');
 assert.equal(document.querySelector('.sc-task'),null);
 assert.equal(calls.filter(c=>c.method!=='GET').length,0,'Console never mutates Task or Authority');
 denied=false;await mount('/settings?technical=1');
 assert.equal(document.querySelector('.sc-shell'),null,'Admin surfaces are accessible only by explicit advanced intent');
 console.log('PASS Sidera Console: two navigation roots, Project→Task→Run drilldown, Node/Executor monitoring, deny-safe no-mock, advanced-only admin');
}finally{root?.unmount();await server.close();dom.window.close();}
