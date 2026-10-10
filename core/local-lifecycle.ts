import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Exact owner only. Never kill by PID/name or replay an unknown stop. */
export function stopLocalCore(root:string):Promise<unknown>{
 const owner=JSON.parse(readFileSync(join(root,'.sidera-dev/sol/data/core-owner.json'),'utf8'));
 return new Promise((resolve,reject)=>{const socket=createConnection(owner.endpoint);let buffer='',done=false;
  const finish=(error:Error|null,result?:unknown)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);};
  socket.setTimeout(10000,()=>finish(Error('STOP_UNCERTAIN')));
  socket.once('connect',()=>socket.write(JSON.stringify({command:'stop',ownerId:owner.ownerId,token:owner.token})+'\n'));
  socket.on('data',data=>{buffer+=data;if(buffer.length>4096)return finish(Error('STOP_UNCERTAIN'));if(buffer.includes('\n')){try{finish(null,JSON.parse(buffer.trim()));}catch{finish(Error('STOP_UNCERTAIN'));}}});
  socket.on('error',()=>finish(Error('OWNER_ENDPOINT_UNAVAILABLE')));socket.on('close',()=>finish(Error('STOP_UNCERTAIN')));
 });
}
