"""Private one-job gateway. Browser execution and all general-purpose upstream APIs absent."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import tempfile
from pathlib import Path

TOKEN = os.environ.get("CRAWL4AI_API_TOKEN", "")
if not re.fullmatch(r"[\x21-\x7e]{24,256}", TOKEN):
    raise RuntimeError("A dedicated scraper token is required")
BUSY = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send(200 if self.path == "/health" else 404, {
            "status": "ready", "mode": "html-only", "busy": BUSY.locked(),
        } if self.path == "/health" else {"success": False})

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + TOKEN).encode()):
            self.send(401, {"success": False})
            return
        if self.path != "/crawl":
            self.send(404, {"success": False})
            return
        if not BUSY.acquire(blocking=False):
            self.send(429, {"success": False})
            return
        scratch = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192 or self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/json":
                self.send(400, {"success": False})
                return
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or set(data) - {"urls", "browser_config", "crawler_config"}:
                raise ValueError("shape")
            if not isinstance(data.get("urls"), list) or len(data["urls"]) != 1:
                raise ValueError("shape")
            # Caller-supplied browser/config objects are never executed or applied.
            # Fixed extraction behavior, robots policy and size limits live in the worker.
            scratch = tempfile.TemporaryDirectory(prefix="marketingbus-extract-")
            env = {"PATH": "/usr/local/bin:/usr/bin:/bin",
                   "CRAWL4_AI_BASE_DIRECTORY": scratch.name,
                   "PYTHONDONTWRITEBYTECODE": "1", "LITELLM_LOCAL_MODEL_COST_MAP": "True",
                   "DO_NOT_TRACK": "1", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
            child = subprocess.Popen([sys.executable, "-I", str(Path(__file__).with_name("html_worker.py"))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=env, start_new_session=True)
            try:
                output, _ = child.communicate(json.dumps({"url": data["urls"][0]}).encode(), timeout=35)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
                self.send(504, {"success": False})
                return
            scratch.cleanup()
            scratch = None
            if child.returncode != 0 or len(output) > 500_000:
                self.send(502, {"success": False})
                return
            result = json.loads(output)
            if result.get("success") is not True:
                raise ValueError("result")
            self.send(200, result)
        except (ValueError, KeyError, TypeError, TimeoutError):
            self.send(400, {"success": False})
        except OSError:
            self.send(502, {"success": False})
        finally:
            if scratch is not None:
                scratch.cleanup()
            BUSY.release()


class Server(ThreadingHTTPServer):
    # Limit simultaneous sockets, including incomplete HTTP requests.
    daemon_threads = True
    slots = threading.BoundedSemaphore(8)

    def __init__(self, address, handler):
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, handler)

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    Server((os.environ.get("SCRAPER_HOST", "::"), int(os.environ.get("PORT", "11235"))), Handler).serve_forever()
