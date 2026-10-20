"""Offline boundary checks; no provider, browser, production database or external request."""
import importlib.util
import io
import gzip
import json
import os
from pathlib import Path
import socket
import threading
import unittest
from email.message import Message
from http.client import HTTPConnection
from unittest.mock import patch

ROOT = Path(__file__).parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

worker = module("html_worker")
os.environ["CRAWL4AI_API_TOKEN"] = "synthetic-local-token-not-for-production"
server = module("html_server")

def dns(_host, _port, **_kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

class Boundaries(unittest.TestCase):
    def test_gzip_is_bounded_and_complete(self):
        self.assertEqual(worker.decode_body(gzip.compress(b"safe"), "gzip", 100), b"safe")
        for body in (gzip.compress(b"x" * 10000), gzip.compress(b"safe")[:-3],
                     gzip.compress(b"safe") + gzip.compress(b"extra")):
            with self.assertRaises(ValueError):
                worker.decode_body(body, "gzip", 100)
    def test_restricted_targets(self):
        for value in ("http://example.com", "https://127.0.0.1", "https://[::1]",
                      "https://user:pass@example.com", "https://x.railway.internal",
                      "https://example.com:80", "https://example.com.\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.target(value)

    def test_all_dns_answers_must_be_public(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                worker.public_addresses("example.com", lambda *a, **kw: dns(*a, **kw) + [
                    (socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))])

    def test_canonical_redirect_only(self):
        self.assertTrue(worker.same_site("https://www.example.com/a", "https://example.com/b"))
        self.assertTrue(worker.same_site("https://example.com/a", "https://www.example.com/b"))
        for destination in ("https://shop.example.com", "https://example.com.evil.test", "https://elsewhere.test"):
            self.assertFalse(worker.same_site("https://example.com", destination))

    def test_robots_fail_closed(self):
        self.assertTrue(worker.robots_allowed("https://example.com/", lambda *a, **kw: (404, "", "", "")))
        self.assertFalse(worker.robots_allowed("https://example.com/", lambda *a, **kw: (503, "", "", "")))
        self.assertFalse(worker.robots_allowed("https://example.com/private", lambda *a, **kw: (200, "", "", "User-agent: *\nDisallow: /private")))

    def test_pinned_numeric_socket_keeps_tls_host(self):
        record = dns("", 0)[0]
        with patch.object(worker.socket, "socket") as sock, patch.object(worker.ssl, "create_default_context") as tls:
            conn = worker.PinnedHTTPS("example.com", record)
            conn.connect()
            sock.return_value.connect.assert_called_once_with(("93.184.216.34", 443))
            tls.return_value.wrap_socket.assert_called_once_with(sock.return_value, server_hostname="example.com")

    def test_html_size_and_redirect_validation(self):
        class Response:
            status = 200
            headers = Message()
            headers["Content-Type"] = "text/html; charset=utf-8"
            def getheader(self, name, default=None):
                return self.headers.get(name, default)
            def read(self, size):
                return b"x" * size
        class Connection:
            response = Response()
            def __init__(self, *_): pass
            def request(self, *_a, **_kw): pass
            def getresponse(self): return self.response
            def close(self): pass
        with self.assertRaisesRegex(ValueError, "size"):
            worker.read_page("https://example.com", 10, Connection, dns)
        Connection.response.status = 302
        Connection.response.headers["Location"] = "https://private.railway.internal/"
        with self.assertRaises(ValueError):
            worker.read_page("https://example.com", 10, Connection, dns)

class Gateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = server.Server(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.host.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.host.shutdown()
        cls.host.server_close()
        cls.thread.join()
    def request(self, path, body, auth=True, kind="application/json"):
        conn = HTTPConnection("127.0.0.1", self.host.server_port, timeout=3)
        try:
            conn.request("POST", path, body, {"Content-Type": kind, **({"Authorization": "Bearer " + server.TOKEN} if auth else {})})
            result = conn.getresponse()
            return result.status, result.read()
        finally:
            conn.close()
    def test_auth_and_fixed_endpoint(self):
        self.assertEqual(self.request("/crawl", "{}", False)[0], 401)
        self.assertEqual(self.request("/execute_js", "{}")[0], 404)
    def test_body_limits_and_no_custom_operations(self):
        for body, kind in [("x" * 8193, "application/json"), ("{}", "text/plain"),
                           ('{"urls":[]}', "application/json"), ('{"urls":["https://example.com"],"hooks":{}}', "application/json")]:
            self.assertEqual(self.request("/crawl", body, kind=kind)[0], 400)
    def test_single_job_capacity(self):
        server.BUSY.acquire()
        try:
            self.assertEqual(self.request("/crawl", "{}")[0], 429)
        finally:
            server.BUSY.release()
    def test_result_and_child_secret_isolation(self):
        with patch.object(server.subprocess, "Popen") as proc:
            proc.return_value.communicate.return_value = (b'{"success":true,"results":[]}', None)
            proc.return_value.returncode = 0
            self.assertEqual(self.request("/crawl", '{"urls":["https://example.com"]}')[0], 200)
            self.assertNotIn("CRAWL4AI_API_TOKEN", proc.call_args.kwargs["env"])
            self.assertNotIn("OPENAI_API_KEY", proc.call_args.kwargs["env"])
            self.assertFalse(Path(proc.call_args.kwargs["env"]["CRAWL4_AI_BASE_DIRECTORY"]).exists())

if __name__ == "__main__":
    unittest.main()
