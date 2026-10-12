/** Test-runner preload, not a production configuration change.
 * Existing LocalSetup tests otherwise probe the installation's 47321/47322.
 * Allocate private loopback ports before those tests create disposable profiles.
 * Run serially with --import ./tests/fixtures/private-loopback.ts.
 */
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { LocalSetup } from "../../core/local-setup.ts";

const servers=[createServer(),createServer()];
const ports:number[]=[];
for(const server of servers){
  await new Promise<void>((ok,fail)=>{server.once("error",fail);server.listen(0,"127.0.0.1",ok);});
  ports.push((server.address() as {port:number}).port);
}
for(const server of servers)await new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()));
const bootstrap=LocalSetup.prototype.bootstrap;
LocalSetup.prototype.bootstrap=function(){
  if(!resolve(this.root).toLowerCase().startsWith((resolve(tmpdir())+sep).toLowerCase()))
    throw new Error("Private-loopback fixture may only initialize disposable temporary roots");
  bootstrap.call(this);
  const spec=this.spec();
  if(spec.corePort===47321 || spec.mcpPort===47322)
    this.writeSpec({...spec,corePort:spec.corePort===47321?ports[0]!:spec.corePort,mcpPort:spec.mcpPort===47322?ports[1]!:spec.mcpPort});
};
