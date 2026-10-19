"""Windows 托盘启动器。开机启动只在明确勾选后写当前用户 Run 项。"""
import argparse
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

DEFAULT_CONFIG={'host':'127.0.0.1','port':8899,'token':'','autostart':False}
APP_NAME='ICR Server'


def data_dir():
    return Path(os.environ.get('LOCALAPPDATA',Path.home()/'.local/share'))/'ICRServer'


def config_path():return data_dir()/'config.json'


def validate(config):
    if type(config['port']) is not int or not 1 <= config['port'] <= 65535:
        raise ValueError('端口必须为 1~65535')
    if config['host'] not in ('127.0.0.1','localhost') and not config.get('token'):
        raise ValueError('非本机监听必须设置 Token')
    return config


def load_config(path=None):
    path=Path(path or config_path())
    if not path.exists():return DEFAULT_CONFIG.copy()
    try:
        value=json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value,dict):raise ValueError('配置必须为 JSON 对象')
        return validate({**DEFAULT_CONFIG,**value})
    except (ValueError,KeyError,TypeError) as exc:
        raise ValueError(f'配置文件无效，请检查 {path}: {exc}') from exc


def save_config(config,path=None):
    validate(config)
    path=Path(path or config_path());path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(path)


def startup_command(executable=None):
    executable=Path(executable or sys.executable)
    if executable is None:raise ValueError('缺少程序路径')
    return f'"{executable.as_posix()}" --tray'


def startup_enabled():
    if sys.platform!='win32':return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            value,_=winreg.QueryValueEx(key,'ICRServer')
        return value==startup_command()
    except FileNotFoundError:return False


def set_startup(enabled):
    if sys.platform!='win32' or not getattr(sys,'frozen',False):
        raise RuntimeError('开机启动仅适用于 Windows 打包 EXE')
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
        if enabled:winreg.SetValueEx(key,'ICRServer',0,winreg.REG_SZ,startup_command())
        else:
            try:winreg.DeleteValue(key,'ICRServer')
            except FileNotFoundError:pass


def setup_logging():
    data_dir().mkdir(parents=True,exist_ok=True)
    handler=RotatingFileHandler(data_dir()/'icr-server.log',maxBytes=2_000_000,backupCount=3,encoding='utf-8')
    logging.basicConfig(level=logging.INFO,handlers=[handler])
    # windowed exe 的 stdout/stderr 为 None，给 OpenCV/uvicorn 一个可写目标。
    if sys.stdout is None:sys.stdout=open(os.devnull,'w')
    if sys.stderr is None:sys.stderr=open(os.devnull,'w')


def self_test(output=None):
    import base64,io
    import cv2
    import numpy as np
    import requests
    from PIL import Image,ImageDraw,ImageFont
    import icr_server
    import local_recognition
    from fastapi.testclient import TestClient
    image=np.full((45,150,3),255,np.uint8)
    pil=Image.fromarray(image);font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',32)
    ImageDraw.Draw(pil).text((5,3),'ab12',font=font,fill='black')
    raw=io.BytesIO();pil.save(raw,'PNG')
    recognized=local_recognition.recognize_text(raw.getvalue())
    assert recognized['ok'] and recognized['text']=='ab12',recognized
    # 真实加载 RapidOCR 的模型，不能只测 import。
    formula=local_recognition.read_math_candidate(raw.getvalue())
    # 文字点选的检测模型（det=True）是单独的模型文件，真实加载并跑一次，防止打包漏掉
    canvas=np.full((160,240,3),255,np.uint8)
    boxes=local_recognition._detect_char_boxes(canvas)
    assert isinstance(boxes,list)
    assert Path(requests.certs.where()).exists()
    with TestClient(icr_server.app) as c:
        health=c.get('/health').json();assert '/slider' in health['endpoints'] and '/textclick' in health['endpoints']
    result={'ok':True,'ocr':recognized['text'],'rapidocr_loaded':True,'textclick_det_loaded':True,'endpoints':health['endpoints']}
    if output:Path(output).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False));return result


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('--tray',action='store_true')
    parser.add_argument('--serve',action='store_true',help='无托盘 HTTP 服务，供容器使用')
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--self-test-output')
    parser.add_argument('--config',type=Path)
    parser.add_argument('--port',type=int)
    parser.add_argument('--smoke-seconds',type=float,help=argparse.SUPPRESS)
    args=parser.parse_args(argv)
    setup_logging()
    if args.self_test:self_test(args.self_test_output);return
    if args.serve:
        import uvicorn
        from icr_server import app
        uvicorn.run(app,host=os.getenv('ICR_HOST','127.0.0.1'),port=int(os.getenv('ICR_PORT','8899')),log_config=None)
        return
    config=load_config(args.config)
    if args.port:config['port']=args.port
    validate(config)
    import socket
    try:
        with socket.socket() as probe:probe.bind((config['host'],config['port']))
    except OSError as exc:
        raise RuntimeError(f"端口 {config['port']} 已占用，未启动第二个实例") from exc
    import icr_server,uvicorn
    icr_server.TOKEN=config['token']
    server=uvicorn.Server(uvicorn.Config(icr_server.app,host=config['host'],port=config['port'],log_config=None))
    import pystray
    from PIL import Image,ImageDraw
    worker=threading.Thread(target=server.run,daemon=True);worker.start()
    deadline=time.monotonic()+20
    while not server.started:
        if not worker.is_alive() or time.monotonic()>deadline:raise RuntimeError('本地服务启动失败，请检查日志')
        time.sleep(.05)
    image=Image.new('RGBA',(64,64),(32,90,180,255));ImageDraw.Draw(image).text((12,20),'ICR',fill='white')
    def startup(icon,item):
        value=not startup_enabled();set_startup(value);config['autostart']=value;save_config(config,args.config);icon.update_menu()
    def stop(icon,item=None):
        server.should_exit=True;icon.stop()
    icon=pystray.Icon('ICRServer',image,f"ICR Server · {config['port']}",menu=pystray.Menu(
        pystray.MenuItem('打开 API 文档',lambda: webbrowser.open(f"http://127.0.0.1:{config['port']}/docs")),
        pystray.MenuItem('打开配置（修改后重启）',lambda: (save_config(config,args.config),os.startfile(str(args.config or config_path())))),
        pystray.MenuItem('打开日志目录',lambda: os.startfile(str(data_dir()))),
        pystray.MenuItem('开机启动（当前用户）',startup,checked=lambda item:startup_enabled(),enabled=bool(getattr(sys,'frozen',False))),
        pystray.MenuItem('退出',stop)))
    if args.smoke_seconds:threading.Timer(args.smoke_seconds,lambda:stop(icon)).start()
    try:icon.run()
    finally:
        server.should_exit=True;worker.join(timeout=8)

if __name__=='__main__':
    try:main()
    except Exception as exc:
        logging.exception('ICR Server 启动失败')
        if sys.platform=='win32' and '--self-test' not in sys.argv:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,str(exc),'ICR Server',0x10)
        raise
