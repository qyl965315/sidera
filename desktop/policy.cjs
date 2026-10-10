const products = Object.freeze({chatgpt:['chatgpt.com'],grok:['grok.com'],claude:['claude.ai'],gemini:['gemini.google.com']});
function exactChat(uri,product){
 product=({'chatgpt-web':'chatgpt','grok-web':'grok','claude-web':'claude','gemini-web':'gemini'})[product]??product;
 if(typeof uri!=='string'||uri.length>2048||/[\s\\\u0000-\u001f]/.test(uri))return false;
 try{const u=new URL(uri);return Boolean(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&products[product]?.includes(u.hostname)&&({chatgpt:/^\/c\/[A-Za-z0-9-]+$/,grok:/^\/chat\/[A-Za-z0-9-]+$/,claude:/^\/chat\/[A-Za-z0-9-]+$/,gemini:/^\/app\/[A-Za-z0-9-]+$/}[product]).test(u.pathname));}catch{return false;}
}
function trustedSender(event,window,origin){return Boolean(window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&new URL(event.senderFrame.url).origin===origin);}
module.exports={exactChat,trustedSender,products};
