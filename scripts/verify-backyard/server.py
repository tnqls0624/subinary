"""실제 배포 게임과 호스트를 격리된 메모리 HTTP 저장소에 연결하는 검증 서버."""
import json
import time
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

ROOT = Path(__file__).resolve().parents[2]
lock = Lock()
state = None
mode = 'normal'
events = []

class Handler(SimpleHTTPRequestHandler):
    """검증 요청 및 실패 주입 내역을 노출한다."""
    def translate_path(self, path):
        if path.startswith('/miniapps/'):
            return str(ROOT / 'apps/web/public' / path.lstrip('/'))
        if path == '/host.js':
            return '/tmp/backyard-s4-host.js'
        return str(ROOT / 'scripts/verify-backyard' / ('index.html' if path == '/' else path.lstrip('/')))

    def reply(self, value, code=200):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/evidence':
            self.reply({'mode': mode, 'state': state, 'events': events})
        elif self.path == '/state':
            events.append({'method': 'GET', 'mode': mode, 'at': time.time()})
            self.reply({'items': [] if state is None else [{'stateKey': 'garden', 'state': state}]}, 503 if mode == 'get-fail' else 200)
        else:
            super().do_GET()

    def do_POST(self):
        global mode, state
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        mode = payload['mode']
        if mode == 'reset':
            state = None
            events.clear()
            mode = 'normal'
        self.reply({'ok': True})

    def do_PUT(self):
        global state
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        current_mode = mode
        events.append({'method': 'PUT', 'mode': current_mode, 'state': payload, 'at': time.time()})
        if current_mode == 'put-timeout':
            time.sleep(10)
        if current_mode == 'put-fail':
            self.reply({'error': '검증 실패 주입'}, 503)
            return
        with lock:
            state = payload
        self.reply({'ok': True})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
