"""CI: run inside the built image; validate security, models and HTTP."""
import base64
import io
import json
import os
import time
import urllib.error
import urllib.request

assert os.getuid()!=0,'container must not run as root'
url='http://127.0.0.1:8899'
health={}
for attempt in range(120):
    try:
        with urllib.request.urlopen(url+'/health',timeout=2) as response:
            health=json.load(response)
        break
    except OSError:
        if attempt==119:raise
        time.sleep(.5)
assert health['ok'] and health['auth_required'] and not health['auth_ok'],health
try:
    urllib.request.urlopen(urllib.request.Request(url+'/ocr',data=b'{}',headers={'Content-Type':'application/json'}))
    raise AssertionError('unauthenticated OCR must be denied')
except urllib.error.HTTPError as exc:
    assert exc.code==401,exc.code
from PIL import Image,ImageDraw,ImageFont
import local_recognition
image=Image.new('RGB',(150,45),'white')
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',32)
ImageDraw.Draw(image).text((5,3),'ab12',font=font,fill='black')
buffer=io.BytesIO();image.save(buffer,'PNG')
raw=buffer.getvalue()
result=local_recognition.recognize_text(raw)
assert result['ok'] and result['text']=='ab12',result
local_recognition.read_math_candidate(raw)  # load/execute RapidOCR too
payload=json.dumps({'image':base64.b64encode(raw).decode(),'mode':'text'}).encode()
request=urllib.request.Request(url+'/ocr',data=payload,headers={'Content-Type':'application/json','X-ICR-Token':os.environ['ICR_TOKEN']})
with urllib.request.urlopen(request,timeout=60) as response:
    result=json.load(response)
assert result['ok'] and result['text']=='ab12',result
print(json.dumps({'ok':True,'uid':os.getuid(),'ocr':result['text'],'rapidocr_loaded':True,'auth_checked':True}))
