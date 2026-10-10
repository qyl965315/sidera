import {readFileSync,writeFileSync} from "node:fs";
import {canonicalMcpServer} from "../hythes/canonical-mcp.ts";
import {registeredToolDetails} from "../hythes/tool-catalog.ts";
/** Display snapshot only: canonical registration decides membership, never this JSON. */
const file="ui/src/capability-catalog.json",current=JSON.parse(readFileSync(file,"utf8")) as Array<Record<string,unknown>>;
const server=canonicalMcpServer({port:0,token:"schema-only"}),details=registeredToolDetails(server);
const manual=current.filter(row=>row.generatedFrom!=="canonical-mcp-registration");
const prior=new Map(current.map(row=>[String(row.name),row]));
const rows=details.map(tool=>({...prior.get(tool.name),name:tool.name,description:tool.description,actor:"Node",
 source:"canonicalMcpServer: "+tool.name,location:"/settings/advanced",group:tool.readOnly?"Read-only inspection":"Node operations",
 executable:false,availability:"Requires current exact Node credentials, Authority and Host observations",
 why:"Reference only in Console. The authenticated Node invokes its canonical tool; Console cannot act as the Node.",
 generatedFrom:"canonical-mcp-registration"}));
const generated=[...manual.filter(row=>!details.some(tool=>tool.name===row.name)),...rows];
const output=JSON.stringify(generated,null,2)+"\n";
if(process.argv.includes("--check")){
 if(readFileSync(file,"utf8")!==output)throw Error("Capability display catalog drifted from canonical registration");
}else writeFileSync(file,output);
await server.close();
console.log("Capability display catalog derives "+details.length+" canonical tools.");
