from pathlib import Path
import zipfile
root=Path('candidates/r1-usability-20261007'); target=root/'Sidera-0.1.0-usability-x64-portable.zip'
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in (root/'portable').rglob('*'):
  if p.is_file(): z.write(p,p.relative_to(root))
with zipfile.ZipFile(target) as z:
 bad=z.testzip()
 if bad: raise RuntimeError(bad)
print('Portable ZIP integrity PASS',target.stat().st_size)
