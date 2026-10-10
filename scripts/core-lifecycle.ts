import {resolve} from 'node:path';
import {stopLocalCore} from '../core/local-lifecycle.ts';
if(process.argv[2]!=='stop')throw Error('Usage: node scripts/core-lifecycle.ts stop');
try{console.log(JSON.stringify(await stopLocalCore(resolve(process.env.SIDERA_PROJECT_ROOT??process.cwd()))));}
catch{console.error('Owner stop unavailable or uncertain; no process killed and no retry');process.exitCode=1;}
