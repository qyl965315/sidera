"""Deliver a new candidate only; existing directories and archived releases are never replaced."""
from pathlib import Path
import sys,shutil,json,hashlib,zipfile,tempfile
mode=sys.argv[1];target=Path(sys.argv[2]).resolve()
if mode=='prepare':
 source=Path(sys.argv[3]).resolve()
 if target.exists():raise SystemExit('Refusing to overwrite an existing candidate')
 target.mkdir(parents=True)
 shutil.copytree(source,target/'package')
 archive=target/'Sidera-R1-Product-Correction-Candidate.zip'
 with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
  for p in sorted((target/'package').rglob('*')):
   if p.is_file():z.write(p,p.relative_to(target/'package').as_posix())
 unpacked=Path(tempfile.mkdtemp(prefix='sidera-final-unpack-'))
 with zipfile.ZipFile(archive) as z:z.extractall(unpacked)
 count=0
 for p in (target/'package').rglob('*'):
  if p.is_file():
   q=unpacked/p.relative_to(target/'package')
   if hashlib.sha256(p.read_bytes()).digest()!=hashlib.sha256(q.read_bytes()).digest():raise SystemExit('Unpack hash mismatch')
   count+=1
 print(json.dumps({'unpacked':str(unpacked),'verifiedFiles':count,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
elif mode=='repack':
 if target.name!='candidate-r1-product-correction':raise SystemExit('Unexpected target')
 scan=json.loads((target/'package/PRIVACY_SCAN.json').read_text())
 scan['rules']=list(scan['rules'])
 (target/'package/PRIVACY_SCAN.json').write_text(json.dumps(scan,indent=2)+'\n',encoding='utf-8')
 sums=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(target/'package').as_posix()+'\n' for p in sorted((target/'package').rglob('*')) if p.is_file() and p.name!='SHA256SUMS')
 (target/'package/SHA256SUMS').write_text(sums,encoding='utf-8')
 archive=target/'Sidera-R1-Product-Correction-Candidate.zip'
 with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
  for p in sorted((target/'package').rglob('*')):
   if p.is_file():z.write(p,p.relative_to(target/'package').as_posix())
 unpacked=Path(tempfile.mkdtemp(prefix='sidera-final-unpack-'))
 with zipfile.ZipFile(archive) as z:z.extractall(unpacked)
 for p in (target/'package').rglob('*'):
  if p.is_file():assert p.read_bytes()==(unpacked/p.relative_to(target/'package')).read_bytes()
 print(json.dumps({'unpacked':str(unpacked),'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
elif mode=='finalize':
 result=json.loads(Path(sys.argv[3]).read_text(encoding='utf-8-sig'))
 if result['state']!='PASS':raise SystemExit('Clean install did not pass')
 public={k:v for k,v in result.items() if k!='root'}
 public.update({'fromFinalArchive':True,'freshTempUnpackHashVerified':True,'LOCAL_READY':True,'FULL_ROUTE_READY':False,'automaticRetry':False,'physicalHumanProof':False,'realExternalE2E':False})
 (target/'CANDIDATE_VALIDATION.json').write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 manifest=json.loads((target/'package/CANDIDATE_MANIFEST.json').read_text(encoding='utf-8'))
 manifest['cleanInstall']='PASS; final ZIP unpacked and hash verified, actual CMD and synthetic browser validation in fresh temp runtime'
 manifest['archiveSha256']=hashlib.sha256((target/'Sidera-R1-Product-Correction-Candidate.zip').read_bytes()).hexdigest()
 manifest['payloadDirectory']='package'
 (target/'CANDIDATE_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 shutil.copy2(target/'package/PRIVACY_SCAN.json',target/'PRIVACY_SCAN.json')
 lines=[]
 for p in sorted(target.rglob('*')):
  if p.is_file() and p!=target/'SHA256SUMS':lines.append(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(target).as_posix())
 (target/'SHA256SUMS').write_text('\n'.join(lines)+'\n',encoding='utf-8')
 print(json.dumps({'state':'PASS','hashEntries':len(lines),'archiveSha256':manifest['archiveSha256'],'verdict':manifest['verdict']}))
else:raise SystemExit('Unknown mode')
