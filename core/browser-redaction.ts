/** Final browser boundary, including configured secret values in free-form strings. */
export function browserSafe(value:unknown,configuration:unknown):unknown{
 const field=/(?:password|secret|credential|authorization|cookie|api[_-]?key|token|private[_-]?key)/i;
 const secrets=new Set<string>();
 function collect(v:unknown){if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')for(const [k,c] of Object.entries(v)){if(field.test(k)&&typeof c==='string'&&c){secrets.add(c);const envName=k==='authTokenEnv'?c:c.startsWith('env:')?c.slice(4):undefined;if(envName&&process.env[envName])secrets.add(process.env[envName]!);}else collect(c);}}
 collect(configuration);
 function clean(v:unknown):unknown{
  if(typeof v==='string'){let text=v;for(const s of secrets)text=text.split(s).join('[REDACTED]');return text.replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');}
  if(Array.isArray(v))return v.map(clean);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,c])=>[k,field.test(k)?'[REDACTED]':clean(c)]));
  return v;
 }
 return clean(value);
}
