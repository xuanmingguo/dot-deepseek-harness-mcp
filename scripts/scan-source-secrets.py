#!/usr/bin/env python3
"""Scan staged/tracked source; never print matching secret values."""
import re,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
paths=subprocess.check_output(['git','ls-files','--cached','-z'],cwd=root).split(b'\0')
rules={
 'private-key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'openai-shaped-key':re.compile(rb'\bsk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{40,}\b'),
 'github-shaped-token':re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{45,})\b'),
 'aws-access-key':re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
}
hits=[]
for raw in paths:
 if not raw:continue
 path=raw.decode()
 f=root/path
 if f.is_symlink():continue
 try:data=f.read_bytes()
 except IsADirectoryError:continue
 for name,pattern in rules.items():
  for match in pattern.finditer(data):
   hits.append({'path':path,'line':data[:match.start()].count(b'\n')+1,'rule':name})
import json
print(json.dumps({'scannedFiles':len([x for x in paths if x]),'findings':hits},indent=2))
raise SystemExit(bool(hits))