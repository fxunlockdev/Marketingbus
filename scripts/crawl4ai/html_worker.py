"""One bounded public-HTTPS read and Crawl4AI text extraction; never executes page JS."""
import http.client
import contextlib
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import zlib
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

MAX_HTML = 2_000_000
MAX_TEXT = 80_000
USER_AGENT = "Marketingbus"
EXCLUDED_TAGS = ["script", "style", "nav", "footer", "header", "iframe",
                 "form", "select", "option", "button", "noscript"]


def failure_code(error):
    """A fixed diagnostic vocabulary, never remote text or exception details."""
    if isinstance(error, ssl.SSLError):
        return "SOURCE_TLS_FAILED"
    if isinstance(error, TimeoutError):
        return "SCRAPER_TIMEOUT"
    if isinstance(error, ValueError):
        return {
            "robots": "SOURCE_ROBOTS_DISALLOWED",
            "restricted": "SOURCE_ADDRESS_RESTRICTED",
            "redirect": "SOURCE_REDIRECT_CHANGED",
            "size": "SOURCE_TOO_LARGE",
            "page": "SOURCE_PAGE_UNAVAILABLE",
            "parse": "SOURCE_INVALID_RESULT",
            "text": "SOURCE_INVALID_RESULT",
            "encoding": "SOURCE_INVALID_RESULT",
        }.get(str(error), "SOURCE_INVALID_RESULT")
    return "SCRAPER_UNAVAILABLE"


def target(value):
    if not isinstance(value, str) or len(value) > 500 or re.search(r"[\x00-\x20\x7f]", value):
        raise ValueError("restricted")
    url = urlsplit(value)
    host = (url.hostname or "").lower()
    if url.scheme != "https" or url.username or url.password or url.port not in (None, 443):
        raise ValueError("restricted")
    if not re.fullmatch(r"[a-z0-9.-]+", host) or "." not in host or host.endswith("."):
        raise ValueError("restricted")
    if any(host == suffix or host.endswith("." + suffix) for suffix in ("localhost", "local", "internal", "home.arpa")):
        raise ValueError("restricted")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("restricted")
    return urlunsplit(("https", host, url.path or "/", url.query, ""))

def same_site(first, second):
    # Only the conventional www/apex pair, never arbitrary related subdomains.
    a, b = urlsplit(target(first)), urlsplit(target(second))
    return a.hostname == b.hostname or a.hostname == "www." + b.hostname or b.hostname == "www." + a.hostname


def public_addresses(host, resolve=socket.getaddrinfo):
    records = resolve(host, 443, type=socket.SOCK_STREAM)
    if not records:
        raise ValueError("restricted")
    for record in records:
        ip = ipaddress.ip_address(record[4][0])
        if not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local:
            raise ValueError("restricted")
    return sorted(records, key=lambda record: record[0] != socket.AF_INET)

def decode_body(body, encoding, max_bytes):
    if encoding == "identity":
        return body
    if encoding != "gzip":
        raise ValueError("encoding")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    result = decoder.decompress(body, max_bytes + 1)
    if len(result) > max_bytes or decoder.unconsumed_tail:
        raise ValueError("size")
    if not decoder.eof or decoder.unused_data:
        raise ValueError("encoding")
    return result


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, record):
        super().__init__(host, timeout=8, context=ssl.create_default_context())
        self.record = record

    def connect(self):
        # Dial the validated numeric address directly: no second DNS lookup.
        family, socktype, proto, _, address = self.record
        raw = socket.socket(family, socktype, proto)
        raw.settimeout(self.timeout)
        try:
            raw.connect(address)
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def read_page(value, max_bytes=MAX_HTML, connection=PinnedHTTPS, resolve=socket.getaddrinfo):
    initial = target(value)
    current = initial
    for _ in range(4):
        url = urlsplit(current)
        records = public_addresses(url.hostname, resolve)
        conn = connection(url.hostname, records[0])
        try:
            conn.request("GET", url.path + ("?" + url.query if url.query else ""),
                         headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain",
                                  "Accept-Encoding": "identity", "Connection": "close"})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                current = target(urljoin(current, response.getheader("Location") or ""))
                if not same_site(initial, current):
                    raise ValueError("redirect")
                continue
            encoding = response.getheader("Content-Encoding", "identity").lower()
            length = response.getheader("Content-Length")
            if length and int(length) > max_bytes:
                raise ValueError("size")
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ValueError("size")
            body = decode_body(body, encoding, max_bytes)
            charset = response.headers.get_content_charset() or "utf-8"
            if charset.lower() not in ("utf-8", "utf8", "ascii", "iso-8859-1", "windows-1252"):
                raise ValueError("encoding")
            return response.status, current, response.headers.get_content_type(), body.decode(charset, errors="strict")
        finally:
            conn.close()
    raise ValueError("redirect")


def robots_allowed(url, reader=read_page):
    parsed = urlsplit(target(url))
    code, _, _, body = reader(urlunsplit(("https", parsed.netloc, "/robots.txt", "", "")), max_bytes=128_000)
    if code in (404, 410):
        return True
    if code != 200:
        return False
    rules = RobotFileParser()
    rules.parse(body.splitlines())
    return rules.can_fetch(USER_AGENT, url)


def extract(url, html):
    # The extractor receives only bytes already fetched through the pinned reader.
    # Disallow network access before importing the library; no models or API keys.
    def blocked(*_args, **_kwargs):
        raise RuntimeError("network disabled during extraction")
    socket.create_connection = blocked
    socket.getaddrinfo = blocked
    socket.socket.connect = blocked
    socket.socket.connect_ex = blocked
    from crawl4ai.content_scraping_strategy import LXMLWebScrapingStrategy
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    scraped = LXMLWebScrapingStrategy().scrap(
        url, html, excluded_tags=EXCLUDED_TAGS,
        word_count_threshold=1,
    )
    if not scraped.success:
        raise ValueError("parse")
    markdown = DefaultMarkdownGenerator().generate_markdown(
        scraped.cleaned_html, base_url=url, citations=False,
        options={"ignore_images": True},
    ).raw_markdown.strip()
    if len(markdown) < 20 or len(markdown.encode("utf-8")) > MAX_TEXT or "\x00" in markdown or "\ufffd" in markdown:
        raise ValueError("text")
    return markdown, str(scraped.metadata.get("title", ""))[:1000]


def main():
    value = json.loads(sys.stdin.buffer.read(8193))
    url = target(value["url"])
    if not robots_allowed(url):
        raise ValueError("robots")
    code, final, kind, html = read_page(url)
    if code != 200 or kind not in ("text/html", "application/xhtml+xml"):
        raise ValueError("page")
    if final != url and not robots_allowed(final):
        raise ValueError("robots")
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet):
        markdown, title = extract(final, html)
    print(json.dumps({"success": True, "results": [{
        "success": True, "url": url, "redirected_url": final,
        "status_code": code, "markdown": {"raw_markdown": markdown},
        "metadata": {"title": title},
    }]}))


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # Never return remote HTML, stack traces, credentials or internal addresses.
        print(json.dumps({"success": False, "error_code": failure_code(error)}))
        sys.exit(1)
