import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import type { EdgeOAuthProvider } from "./mcp-oauth.ts";

/** This listener is loopback-only, and never forwarded to public MCP ingress. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;",
    '"':"&quot;", "'":"&#39;" })[ch]!);
}
function page(title: string, content: string): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    +'<meta name="viewport" content="width=device-width, initial-scale=1">'
    +'<title>'+escapeHtml(title)+'</title>'
    +'<style>body{font:16px system-ui,sans-serif;max-width:670px;margin:8vh auto;'
    +'padding:0 22px;color:#182231;line-height:1.7}article{border:1px solid #aaa;'
    +'border-radius:12px;padding:22px}button{font:inherit;background:#1769d1;color:white;'
    +'padding:10px 20px;border:0;border-radius:8px;cursor:pointer}'
    +'code{overflow-wrap:anywhere}small{color:#555}</style></head><body>'
    +'<h2>'+escapeHtml(title)+'</h2>'+content+'</body></html>';
}
function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type":"text/html; charset=utf-8",
    "Cache-Control":"no-store", "Referrer-Policy":"same-origin",
    "X-Frame-Options":"DENY", "X-Content-Type-Options":"nosniff",
    "Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!String(req.headers["content-type"]??"").startsWith("application/x-www-form-urlencoded"))
    throw Error("Only browser form posts are accepted");
  let body="";
  for await (const chunk of req) {
    body+=Buffer.from(chunk).toString("utf8");
    if (body.length>4096)throw Error("Form too large");
  }
  return new URLSearchParams(body);
}
export async function startLocalOAuthConsent(oauth: EdgeOAuthProvider, port: number): Promise<{ port:number;close():Promise<void> }> {
  const csrf = new Map<string,{ requestId:string;expiresAt:number }>();
  let boundPort=0;
  const server=createServer((req,res)=>{
    void (async()=>{
      const host=String(req.headers.host??"");
      if (host!=="127.0.0.1:"+boundPort && host!=="localhost:"+boundPort) {
        respond(res,403,page("拒绝访问","<p>仅允许本机授权。</p>"));return;
      }
      const url=new URL(req.url??"/","http://127.0.0.1:"+boundPort);
      const requestId=url.searchParams.get("request")??"";
      if(req.method==="GET" && url.pathname==="/"){
        const pending=oauth.pendingOwnerRequest(requestId);
        if(!pending){respond(res,404,page("授权请求无效","<p>请求已过期。请回到 ChatGPT 再次连接。</p>"));return;}
        const token=randomBytes(32).toString("base64url");
        if(csrf.size>100)csrf.clear();
        csrf.set(token,{requestId,expiresAt:Date.now()+120_000});
        const content='<article><p>核对发起授权的产品与下方信息，然后决定是否允许它使用此 Node 的连接。</p>'
          +'<p><strong>客户端：</strong>'+escapeHtml(pending.clientName)+'</p>'
          +'<p><strong>Node：</strong><code>'+escapeHtml(pending.boundNodeId)+'</code></p>'
          +'<p><strong>回调地址：</strong><code>'+escapeHtml(pending.redirectUri)+'</code></p>'
          +'<p><strong>核对码：</strong><code>'+escapeHtml(pending.displayCode)+'</code></p>'
          +'<p><small>只授权 MCP 连接身份，不额外授予 Sidera Authority。若不是你刚在 ChatGPT 发起的连接，请关闭页面。</small></p>'
          +'<form method="post" action="/approve"><input type="hidden" name="request" value="'+escapeHtml(requestId)+'">'
          +'<input type="hidden" name="csrf" value="'+escapeHtml(token)+'">'
          +'<button type="submit">确认是我发起的连接，并批准</button></form></article>';
        respond(res,200,page("Sidera 本机连接确认",content));return;
      }
      if(req.method==="POST" && url.pathname==="/approve"){
        const origin=String(req.headers.origin??"");
        const site=String(req.headers["sec-fetch-site"]??"");
        if((origin!=="http://127.0.0.1:"+boundPort && origin!=="http://localhost:"+boundPort) ||
           (site && site!=="same-origin" && site!=="none")){
          console.warn("[Sidera local approval] rejected form source: origin="+JSON.stringify(origin)+
            " fetchSite="+JSON.stringify(site)+" hostMatchesLocal=true");
          respond(res,403,page("来源被拒绝","<p>此授权必须从本机 Sidera 确认页面提交。</p>"));return;
        }
        const form=await readForm(req),id=form.get("request")??"",key=form.get("csrf")??"";
        const claim=csrf.get(key); csrf.delete(key);
        if(!claim||claim.requestId!==id||claim.expiresAt<Date.now()||!oauth.approveOwnerRequest(id)){
          respond(res,409,page("请求已过期","<p>未批准任何连接。请重新从 ChatGPT 发起授权。</p>"));return;
        }
        respond(res,200,page("Sidera 已确认",'<article><p>授权已由本机确认。返回原来的 ChatGPT 授权标签页，连接会自动继续。</p>'
          +'<p><small>没有授予额外的操作权限。</small></p></article>'));return;
      }
      respond(res,404,page("页面不存在","<p>无效地址。</p>"));
    })().catch(()=>respond(res,400,page("请求无效","<p>无法处理此请求。</p>")));
  });
  await new Promise<void>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,"127.0.0.1",()=>{server.off("error",reject);resolve();});
  });
  const addr=server.address();
  if(!addr||typeof addr==="string")throw Error("Local approval listener has no port");
  boundPort=addr.port;
  return { port:boundPort,close:()=>new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve())) };
}
