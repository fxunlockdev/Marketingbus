import { once } from "node:events";
import { connect as tcpConnect, createServer as tcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicEgressProxy, publicHostname } from "../scripts/firecrawl/public-egress-proxy.mjs";

const password = "local-fixture-credential-only-12345";
const auth = `Basic ${Buffer.from(`scraper:${password}`).toString("base64")}`;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options = {}) {
  const server = createPublicEgressProxy({ password, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => server.shutdown());
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing address");
  return { server, port: address.port };
}
async function open(port: number, authority: string, authorization: string | null = auth) {
  const socket = tcpConnect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`);
  const [data] = await once(socket, "data");
  return { socket, response: data.toString() as string };
}
async function upstream() {
  const clients = new Set<Socket>();
  const server = tcpServer(socket => {
    clients.add(socket); socket.once("close", () => clients.delete(socket));
    socket.on("data", data => socket.write(data));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => { for (const socket of clients) socket.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing address");
  // Test transport redirects to our local echo fixture only after checking the
  // production dial options. The proxy itself never accepts a loopback answer.
  return vi.fn((options: { host: string; port: number; family: number }) => {
    expect(options).toEqual({ host: "93.184.216.34", port: 443, family: 4 });
    return tcpConnect(address.port, "127.0.0.1");
  });
}
const publicAnswer = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

describe("scraper-only public egress", () => {
  it.each(["localhost:443", "db.railway.internal:443", "foo.local:443", "localhost.:443", "home.arpa:443",
    "127.0.0.1:443", "127.1:443", "2130706433:443", "0x7f000001:443", "0.0.0.0:443", "10.0.0.1:443", "169.254.169.254:443",
    "100.64.0.1:443", "192.168.1.1:443", "224.0.0.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443", "[fc00::1]:443",
    "[fe80::1]:443", "example.com:80", "example.com:8443", "example.com:443/path", "user@example.com:443", "example.com:443?x=y"])("rejects restricted authority %s", authority => {
    expect(() => publicHostname(authority)).toThrow();
  });
  it.each(["example.com:443", "EXAMPLE.com.:443", "93.184.216.34:443", "[2606:4700:4700::1111]:443"])("accepts public HTTPS authority %s", authority => {
    expect(publicHostname(authority)).toBeTruthy();
  });
  it.each([undefined, "", "short", "a".repeat(257), "private\ncredential".repeat(3)])("requires a bounded private credential (%#)", value => {
    expect(() => createPublicEgressProxy({ password: value })).toThrow();
  });
  it("challenges unauthenticated callers without resolving or connecting", async () => {
    const resolve = vi.fn(publicAnswer); const connect = vi.fn();
    const { port } = await fixture({ resolve, connect });
    const result = await open(port, "example.com:443", null);
    expect(result.response).toContain("407 Proxy Authentication Required");
    expect(result.response).toContain('Proxy-Authenticate: Basic realm="scraper"');
    result.socket.destroy(); expect(resolve).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
  it.each([[], [{ address: "127.0.0.1", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "::ffff:169.254.169.254", family: 6 }], [{ address: "not-an-ip", family: 4 }], [{ address: "93.184.216.34", family: 6 }]].map(records => ({ records })))("blocks empty, restricted, mixed and invalid DNS answers (%#)", ({ records }) => {
    return (async () => {
      const connect = vi.fn(); const { port } = await fixture({ resolve: async () => records, connect });
      const result = await open(port, "example.com:443");
      expect(result.response).toContain("403 Forbidden"); result.socket.destroy(); expect(connect).not.toHaveBeenCalled();
    })();
  });
  it("pins the validated numeric address and rechecks DNS for every new tunnel", async () => {
    const connect = await upstream();
    const resolve = vi.fn().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const { port } = await fixture({ resolve, connect });
    const first = await open(port, "example.com:443"); expect(first.response).toContain("200 Connection Established");
    const echoed = once(first.socket, "data"); first.socket.write("fixture TLS payload");
    expect((await echoed)[0].toString()).toBe("fixture TLS payload");
    first.socket.destroy();
    const second = await open(port, "example.com:443"); expect(second.response).toContain("403 Forbidden"); second.socket.destroy();
    expect(resolve).toHaveBeenCalledTimes(2); expect(connect).toHaveBeenCalledTimes(1);
  });
  it("does not leak resolver failure details", async () => {
    const { port } = await fixture({ resolve: async () => { throw Error("private-dns-secret"); } });
    const result = await open(port, "example.com:443");
    expect(result.response).toContain("403 Forbidden"); expect(result.response).not.toContain("secret"); result.socket.destroy();
  });
  it("bounds an unresponsive DNS lookup without opening an upstream connection", async () => {
    const connect = vi.fn(); const { port } = await fixture({ resolve: () => new Promise(() => {}), connect, dnsTimeoutMs: 25 });
    const result = await open(port, "example.com:443");
    expect(result.response).toContain("403 Forbidden"); result.socket.destroy(); expect(connect).not.toHaveBeenCalled();
  });
  it("does not accumulate unresolved OS lookups after caller timeouts", async () => {
    const resolve = vi.fn(() => new Promise(() => {}));
    const { port } = await fixture({ resolve, dnsTimeoutMs: 25, maxTunnels: 1 });
    const first = await open(port, "example.com:443"); expect(first.response).toContain("403 Forbidden"); first.socket.destroy();
    const second = await open(port, "example.com:443"); expect(second.response).toContain("503 Service Unavailable"); second.socket.destroy();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("caps active tunnels and releases a closed tunnel", async () => {
    const connect = await upstream(); const { port } = await fixture({ resolve: publicAnswer, connect, maxTunnels: 1 });
    const first = await open(port, "example.com:443");
    const second = await open(port, "example.com:443"); expect(second.response).toContain("503 Service Unavailable"); second.socket.destroy();
    first.socket.destroy(); await once(first.socket, "close");
    // Wait for the server-side close event, not just the client notification.
    await vi.waitFor(async () => { const result = await open(port, "example.com:443"); result.socket.destroy(); expect(result.response).toContain("200 Connection Established"); });
  });
  it("closes a tunnel at its absolute deadline even if the destination stays connected", async () => {
    const connect = await upstream(); const { port } = await fixture({ resolve: publicAnswer, connect, timeoutMs: 50 });
    const result = await open(port, "example.com:443");
    await once(result.socket, "close"); expect(result.socket.destroyed).toBe(true);
  });
  it("closes a tunnel that exceeds its aggregate byte allowance", async () => {
    const connect = await upstream(); const { port } = await fixture({ resolve: publicAnswer, connect, maxBytes: 32 });
    const result = await open(port, "example.com:443");
    const closed = once(result.socket, "close"); result.socket.write(Buffer.alloc(64)); await closed;
    expect(result.socket.destroyed).toBe(true);
  });
  it("rejects direct HTTP requests rather than making an unguarded fetch", async () => {
    const connect = vi.fn(); const { port } = await fixture({ connect });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(403); expect(connect).not.toHaveBeenCalled();
  });
});
