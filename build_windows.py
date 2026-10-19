"""Run with isolated build venv; bundle models + native libraries, no system Python dependency."""
import subprocess
import sys
from pathlib import Path

root=Path(__file__).resolve().parent
scratch=Path(__import__('os').environ.get('TMPDIR',root/'build')).resolve()
cmd=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onefile','--windowed','--noupx',
     '--name','icr-server','--distpath',str(root/'dist'),
     '--workpath',str(scratch/'icr-pyinstaller-work'),'--specpath',str(scratch/'icr-pyinstaller-spec'),
     '--collect-all','ddddocr','--collect-all','rapidocr_onnxruntime','--collect-all','onnxruntime',
     '--collect-submodules','pystray','--collect-submodules','uvicorn',
     '--hidden-import','httpx','--hidden-import','fastapi.testclient',
     '--add-data',f'{root / "ICR_LICENSE.txt"};.',str(root/'desktop_app.py')]
subprocess.run(cmd,cwd=root,check=True)
print(root/'dist/icr-server.exe')
