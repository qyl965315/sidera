import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import React from "react";
const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:"http://localhost/"});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
const {createRoot}=await import("react-dom/client");
const server=await createServer({configLoader:"runner",server:{middlewareMode:true},appType:"custom"});
const pause=()=>new Promise(r=>setTimeout(r,60));
let root;const calls=[];
try{
 const {default:Console}=await server.ssrLoadModule("/src/ConsolePanel.tsx");
 const policy={reviewers:"Human",reviewerSelection:"Human",humanInvolvement:"required",reviewerCount:0};
 const base={kind:"Console",isNode:false,nodes:[],chiefConversations:[],history:[],omega:[],conflicts:[],grants:[],responsibility:[]};
 const mount=async(proposal)=>{
  root?.unmount();root=createRoot(document.getElementById("root"));
  root.render(React.createElement(Console,{data:{...base,ruleProposals:[proposal]},english:false,onReviewRule:(...args)=>calls.push(args)}));await pause();
  [...document.querySelectorAll("button")].find(b=>b.textContent==="规则与审阅").click();await pause();
 };
 await mount({proposalId:"world",object:{level:"World",scopeRef:"world"},reviewPolicy:policy,reviews:[]});
 let button=[...document.querySelectorAll("button")].find(b=>b.textContent==="核对并审阅此精确版本");
 assert.equal(button.disabled,false);button.click();assert.deepEqual(calls.pop(),["world",undefined]);
 const machine={...policy,reviewers:"Human+Machine",reviewerSelection:"AuthorizedOperator",humanInvolvement:"optional",independentRequired:true,allowSelfReview:false,reviewerCount:2};
 await mount({proposalId:"project",proposerNodeId:"issuer",object:{level:"Project",scopeRef:"project"},reviewPolicy:machine,
  reviews:[{task_id:"review-one",reviewer_node_id:"one",reviewerKind:"Operator",state:"completed"},{task_id:"review-two",reviewer_node_id:"two",reviewerKind:"Operator",state:"completed"}]});
 button=[...document.querySelectorAll("button")].find(b=>b.textContent==="核对并审阅此精确版本");assert.equal(button.disabled,true);
 document.querySelectorAll('input[type="checkbox"]')[0].click();await pause();assert.equal(button.disabled,true);
 document.querySelectorAll('input[type="checkbox"]')[1].click();await pause();assert.equal(button.disabled,false);button.click();
 assert.deepEqual(calls.pop(),["project",["review-one","review-two"]]);
 await mount({proposalId:"machine",object:{level:"Task",scopeRef:"task"},reviewPolicy:{...machine,reviewers:"Machine",humanInvolvement:"none"},reviews:[]});
 assert.equal([...document.querySelectorAll("button")].some(b=>b.textContent==="核对并审阅此精确版本"),false);
 console.log("PASS: World Human preview, optional Human with two exact reviewer IDs, and no-Human policy.");
}finally{root?.unmount();await server.close();dom.window.close();}
