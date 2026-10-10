from pathlib import Path
p=Path('hythes/mcp-gateway.ts');s=p.read_text(encoding='utf-8').replace('import { mcpAuthRouter }','import { mcpAuthRouter, createOAuthMetadata }');a='    app.use(mcpAuthRouter({ provider: oauth, issuerUrl: oauth.issuerUrl,';b='''    // The SDK default advertises refresh_token although this provider never issues one.
    const metadata=createOAuthMetadata({provider:oauth,issuerUrl:oauth.issuerUrl,scopesSupported:['sidera.mcp']});
    metadata.grant_types_supported=['authorization_code'];
    metadata.token_endpoint_auth_methods_supported=[...new Set(oauth.config.clients.map(c=>c.clientSecret?'client_secret_post':'none'))];
    metadata.revocation_endpoint_auth_methods_supported=metadata.token_endpoint_auth_methods_supported;
    app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json(metadata));
    app.use(mcpAuthRouter({ provider: oauth, issuerUrl: oauth.issuerUrl,''';assert a in s;s=s.replace(a,b);p.write_text(s,encoding='utf-8')
p=Path('hythes/mcp-oauth.ts');s=p.read_text(encoding='utf-8');s=s.replace('this.redirectError(params.redirectUri, "invalid_request", "Unregistered redirect_uri", params.state, res); return;','res.status(400).json({error:"invalid_request",error_description:"Unregistered redirect_uri"}); return;');p.write_text(s,encoding='utf-8')
p=Path('tests/mcp-oauth.test.ts');s=p.read_text(encoding='utf-8').replace('options: { accessTokenTtlSeconds?: number }','options: { accessTokenTtlSeconds?: number; publicClient?:boolean }').replace('clientSecret: randomBytes(24).toString("base64url") };','clientSecret: options.publicClient ? "" : randomBytes(24).toString("base64url") };');s+='''
test('O-T12 public PKCE metadata, no refresh promise, exact redirects and durable reconnect',async()=>{
 const h=await harness({publicClient:true});try{
 const metadata=await fetch(h.base+'/.well-known/oauth-authorization-server').then(r=>r.json());
 assert.deepEqual(metadata.grant_types_supported,['authorization_code']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
 const minted=await mint(h,h.chatClient);assert.equal(minted.refresh_token,undefined);assert.equal((await mcpCall(h.resource,minted.access_token)).nodeId,CHAT_NODE);
 const refresh=await tokenRequest(h,{grant_type:'refresh_token',refresh_token:'not-issued',client_id:h.chatClient.clientId});assert.equal(refresh.status,400);
 const invalid=await fetch(h.base+'/authorize?'+new URLSearchParams({client_id:h.chatClient.clientId,response_type:'code',redirect_uri:'https://unregistered.example/callback',code_challenge:pkce().challenge,code_challenge_method:'S256'}),{redirect:'manual'});assert.equal(invalid.headers.get('location'),null);assert.equal(invalid.status,400);
 const restarted=new EdgeOAuthProvider(h.oauth.config,(h.oauth as unknown as {statePath:string}).statePath);assert.equal((await restarted.verifyAccessToken(minted.access_token)).clientId,h.chatClient.clientId);
 }finally{await h.listener.close();}
});
''';p.write_text(s,encoding='utf-8')
