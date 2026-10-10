const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');const {exactChat,trustedSender}=require('./policy.cjs');
test('exact external URL allowlist rejects arbitrary schemes, credentials, hosts and product mismatch',()=>{
 assert.equal(exactChat('https://chatgpt.com/c/exact-recorded-id','chatgpt-web'),true);
 for(const url of ['http://chatgpt.com/c/x','javascript:alert(1)','file:///C:/x','https://chatgpt.com.evil.test/c/x','https://a:secret@chatgpt.com/c/x','https://chatgpt.com/','https://chatgpt.com/c/x?token=x','https://chatgpt.com:444/c/x','https://chatgpt.com/c/x#x'])assert.equal(exactChat(url,'chatgpt-web'),false,url);
 assert.equal(exactChat('https://chatgpt.com/c/x','grok'),false);
});
test('IPC sender must be the exact main frame and trusted window origin',()=>{
 const frame={url:'http://127.0.0.1:123/setup'},wc={mainFrame:frame},win={webContents:wc,isDestroyed:()=>false},event={sender:wc,senderFrame:frame};
 assert.equal(trustedSender(event,win,'http://127.0.0.1:123'),true);
 assert.equal(trustedSender({...event,senderFrame:{url:frame.url}},win,'http://127.0.0.1:123'),false);
 assert.equal(trustedSender(event,win,'https://evil.test'),false);
 assert.equal(trustedSender({...event,sender:{}},win,'http://127.0.0.1:123'),false);
});
test('preload exposes bounded product and encrypted-key actions, no shell or Human admission API',()=>{
 const s=fs.readFileSync(__dirname+'/preload.cjs','utf8');assert.equal((s.match(/ipcRenderer.invoke\(/g)||[]).length,15);
 for(const token of ['exec','spawn','sendSync','process.env','confirm','rpc'])assert.equal(s.includes(token),false);
 const main=fs.readFileSync(__dirname+'/main.cjs','utf8');for(const setting of ['contextIsolation:true','sandbox:true','nodeIntegration:false','webviewTag:false'])assert.ok(main.includes(setting));
 assert.ok(main.includes('apiCredentials.save(credentialRef,key,process.env)'));assert.ok(main.includes("desktop:save-api-credential"));assert.ok(s.includes('saveApiCredential'));assert.ok(!s.includes('saveDeepSeekKey'));assert.ok(!s.includes('decryptString'));
});
