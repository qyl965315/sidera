from pathlib import Path
import json, hashlib, shutil, datetime
root=Path('.')
cand=root/'candidates'/'r1-usability-20261007'
obs={
  'source':'supervising ChatGPT connector observation after controlled Gateway reload',
  'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'controlledGatewayReload':True,
  'publicOAuthMetadata':{
    'grant_types_supported':['authorization_code'],
    'token_endpoint_auth_methods_supported':['none'],
    'code_challenge_methods_supported':['S256']
  },
  'chatgptConnectorRoundTrip':{
    'state':'OBSERVED',
    'operation':'sidera.status',
    'registeredOperations':48,
    'runtimeReady':True,
    'meaning':'The current ChatGPT connector successfully authenticated to and read Sidera after the Gateway reload.'
  },
  'chiefPrimaryBinding':{
    'state':'NOT_ESTABLISHED',
    'probe':'chief.frontend_prepare',
    'result':'REJECTED: Chief binding required',
    'meaning':'Connector transport/auth is working, but the exact Human-owned Primary/Chief conversation binding is still missing.'
  },
  'boundary':'This is connector reachability/auth evidence, not exact conversation Presence, Human approval, Authority grant, or external model acceptance.'
}
(root/'usability-evidence'/'post-reload-chatgpt-roundtrip.json').write_text(json.dumps(obs,indent=2),encoding='utf-8')

p=root/'R1_USABILITY_CLOSURE_REPORT.md'
s=p.read_text(encoding='utf-8')
s=s.replace('Running Gateway still advertises the older refresh metadata because its live process was preserved. A controlled reload is required before this fix appears at the public endpoint. No live connector authorization/token flow was initiated. ChatGPT product reconnect remains UNVERIFIED.', 'The Gateway was then controlled-reloaded without restarting Core or the dev tunnel. Public OAuth metadata now advertises only authorization_code with public-client auth method none, matching the implemented flow. After that reload, this supervising ChatGPT conversation successfully called sidera.status through the connector, so connector transport/auth round-trip is OBSERVED. A direct chief.frontend_prepare probe still returned `Chief binding required`; therefore the exact Human-owned Primary/Chief conversation binding and exact Presence remain unestablished. No new interactive OAuth login flow or Human approval was initiated.')
s=s.replace('The running production Gateway metadata has not been reloaded.', 'The production Gateway metadata fix is now loaded; the remaining ChatGPT-side limitation is exact Human-owned Primary/Chief conversation binding, not Gateway reachability.')
p.write_text(s,encoding='utf-8')

p=root/'R1_USABILITY_CLOSURE_RESULT.md'
s=p.read_text(encoding='utf-8')
s=s.replace('Production Gateway still runs pre-audit metadata until controlled reload.', 'Production Gateway was controlled-reloaded and now serves the audited OAuth metadata.')
s=s.replace('Local and public /healthz and /readyz: HTTP 200, ready=true. Product reconnect still UNVERIFIED.', 'Local and public /healthz and /readyz: HTTP 200, ready=true. After controlled Gateway reload, this ChatGPT conversation successfully completed a `sidera.status` connector round-trip. Exact Primary/Chief binding is still NOT ESTABLISHED (`chief.frontend_prepare` -> `Chief binding required`).')
p.write_text(s,encoding='utf-8')

fv=root/'usability-evidence'/'final-validation.json'
try: data=json.loads(fv.read_text(encoding='utf-8'))
except: data={}
data['productionGatewayReloaded']=True
data['publicOAuthMetadataAfterReload']='PASS: authorization_code only; public client auth method none; S256'
data['chatgptConnectorRoundTripAfterReload']='OBSERVED: sidera.status succeeded from current ChatGPT connector'
data['primaryChiefBinding']='NOT_ESTABLISHED: chief.frontend_prepare rejected Chief binding required'
data['productReconnect']='TRANSPORT_AUTH_OBSERVED_PRIMARY_BINDING_PENDING'
fv.write_text(json.dumps(data,indent=2),encoding='utf-8')

for name in ['R1_USABILITY_CLOSURE_REPORT.md','R1_USABILITY_CLOSURE_RESULT.md']:
    shutil.copy2(root/name,cand/name)
# Refresh candidate top-level checksum manifest without changing binaries/portable zip.
def sha(p):
    h=hashlib.sha256();
    with open(p,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
files=['portable/Sidera.exe','Sidera-0.1.0-usability-x64-setup.exe','Sidera-0.1.0-usability-x64-portable.zip']
files += sorted([p.name for p in cand.iterdir() if p.is_file() and (p.suffix=='.md' or p.suffix=='.blockmap')])
(cand/'SHA256SUMS.txt').write_text('\n'.join(f'{sha(cand/f)}  {f}' for f in files)+'\n',encoding='utf-8')
print(json.dumps(obs,indent=2))
