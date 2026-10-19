import json,base64
from pathlib import Path
import cv2,numpy as np,ddddocr
root=(Path(__file__).resolve().parents[1]/'reports/private');d=json.loads((root/'slider-request.json').read_text(encoding='utf-8'))
def image(s):return cv2.imdecode(np.frombuffer(base64.b64decode(s.split(',')[-1]),np.uint8),cv2.IMREAD_UNCHANGED)
bg=image(d['bg']);piece=image(d['piece']);x,y,w,h=d['piece_crop'];piece=piece[y:y+h,x:x+w];piece=cv2.resize(piece,None,fx=d['piece_scale'],fy=d['piece_scale'])
cv2.imwrite(str(root/'bg.png'),bg);cv2.imwrite(str(root/'piece.png'),piece)
print('dimensions',bg.shape,piece.shape,d['piece_crop'],d['piece_scale'])
s=ddddocr.DdddOcr(det=False,ocr=False,show_ad=False)
print('ddddocr',s.slide_match(cv2.imencode('.png',piece)[1].tobytes(),cv2.imencode('.png',bg)[1].tobytes()))
# Mask the outside; a dark gap loses color, but shape perimeter survives.
a=piece[:,:,3]>127;ys,xs=np.where(a);t=piece[ys.min():ys.max()+1,xs.min():xs.max()+1];mask=t[:,:,3]
g=cv2.cvtColor(bg,cv2.COLOR_BGR2GRAY);p=cv2.cvtColor(t[:,:,:3],cv2.COLOR_BGR2GRAY)
for mode in ['edge','color']:
 if mode=='edge':r=cv2.matchTemplate(cv2.Canny(g,50,150),cv2.Canny(p,50,150),cv2.TM_CCORR_NORMED)
 else:r=cv2.matchTemplate(g,p,cv2.TM_CCORR_NORMED,mask=mask)
 _,mx,_,loc=cv2.minMaxLoc(np.nan_to_num(r,nan=-1,posinf=-1,neginf=-1));print(mode,mx,loc)
