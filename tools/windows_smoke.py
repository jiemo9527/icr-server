"""CI: execute the frozen EXE outside the checkout; never enable startup."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
exe=root/'dist/icr-server.exe'
report=root/'reports/ci-exe-self-test.json'
report.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='icr-smoke-',dir=os.environ.get('TMPDIR')) as work:
    subprocess.run([str(exe),'--self-test','--self-test-output',str(report)],cwd=work,check=True,timeout=180)
    result=json.loads(report.read_text(encoding='utf-8'))
    assert result['ok'] and result['rapidocr_loaded'] and result.get('textclick_det_loaded'),result
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]
    cfg=Path(work)/'config.json'
    cfg.write_text(json.dumps({'host':'127.0.0.1','port':port,'token':'','autostart':False}),encoding='utf-8')
    proc=subprocess.Popen([str(exe),'--tray','--config',str(cfg),'--smoke-seconds','15'],cwd=work)
    try:
        deadline=time.monotonic()+90
        while True:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as response:
                    health=json.load(response)
                assert health['ok'] and not health['auth_required'],health
                break
            except OSError:
                if proc.poll() is not None or time.monotonic()>deadline:raise
                time.sleep(.25)
        assert proc.wait(timeout=45)==0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
print('Frozen model self-test and tray HTTP lifecycle passed')
