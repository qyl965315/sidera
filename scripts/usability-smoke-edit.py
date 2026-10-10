from pathlib import Path
p=Path('ui/scripts/ux-smoke.mjs');s=p.read_text(encoding='utf-8-sig')
s=s.replace("const inventory={onboarding:","window.sideraDesktop={openProduct:async()=>({opened:true}),saveDeepSeekKey:async()=>({saved:true})};\nconst inventory={integrations:[],onboarding:")
s=s.replace("configuration:'Not configured',authenticated:'UNVERIFIED'", "configuration:'Not configured',authenticated:'UNVERIFIED',detection:{installed:adapter==='codex-app-server',supported:adapter==='codex-app-server'}")
s=s.replace("if(op==='node'){", "if(op==='node'||op==='executable-host'){")
s=s.replace("if(op==='confirm'){assert.equal(input.confirmation,'CONFIRM synthetic');", "if(op==='approve'){assert.deepEqual(input,{reviewId:uuid});")
a=s.index(" await click('开始设置');");b=s.index(' const audits=[]',a)
s=s[:a]+""" await click('开始设置');await click('连接 / 查看');await click('连接');assert.equal(calls.at(-1).op,'executable-host');assert.deepEqual(calls.at(-1).input,{automatic:true,hostKind:'codex-app-server'});await click('关闭');await click('继续');await input('你的称呼','测试身份');await click('确认身份');assert.ok(document.querySelector('.wizard-content').textContent.includes('应用权限'));await click('审查并应用权限');assert.equal(document.querySelectorAll('[role="dialog"]').length,1);assert.equal(document.querySelector('.dialog input'),null);assert.equal(document.querySelectorAll('.dialog details').length,1);assert.equal(document.querySelector('.dialog .primary').disabled,false);await click('批准并继续');await click('已应用，继续');await click('暂时跳过');await click('开始工作');assert.ok(document.querySelector('.work-surface'));assert.equal(calls.filter(c=>c.op==='approve').length,1);
"""+s[b:]
s=s.replace("['Codex','DeepSeek','Grok','Gemini','GLM','DSH','MCP']","['Codex','DeepSeek API','Grok','Gemini','GLM / ZCode','DeepSeek Harness','MCP']").replace("await click('设置服务')","await click('连接 / 查看')")
s=s.replace('typed review dialog','one-click native review request')
p.write_text(s,encoding='utf-8')
