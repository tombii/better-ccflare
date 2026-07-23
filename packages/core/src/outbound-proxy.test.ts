import { afterEach, describe, expect, it } from "bun:test";
import {
	installOutboundProxy,
	uninstallOutboundProxy,
} from "@better-ccflare/core";

interface FakeProxy {
	server: ReturnType<typeof Bun.listen>;
	port: number;
	requestLines: string[];
}

interface FetchInitWithProxy extends RequestInit {
	proxy?: string;
}

function startFakeProxy(): FakeProxy {
	const requestLines: string[] = [];
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, chunk) {
				const text = Buffer.from(chunk).toString("utf8");
				const firstLine = text.split("\r\n")[0] ?? "";
				requestLines.push(firstLine);
				socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
				socket.end();
			},
		},
	});
	return { server, port: server.port ?? 0, requestLines };
}

describe("outbound-proxy", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		uninstallOutboundProxy();
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("routes external requests through the resolved proxy", async () => {
		const proxy = startFakeProxy();
		cleanups.push(() => proxy.server.stop(true));

		installOutboundProxy(() => `http://127.0.0.1:${proxy.port}`);

		const response = await fetch("https://outbound-proxy-test.invalid/x");
		expect(response.status).toBe(502);
		expect(proxy.requestLines.length).toBeGreaterThan(0);
		expect(proxy.requestLines[0]).toStartWith(
			"CONNECT outbound-proxy-test.invalid:443",
		);
	});

	it("excludes loopback destinations from proxying", async () => {
		const proxy = startFakeProxy();
		cleanups.push(() => proxy.server.stop(true));

		const localServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response("local-ok", {
					status: 200,
					headers: { "x-marker": "local" },
				});
			},
		});
		cleanups.push(() => localServer.stop(true));

		installOutboundProxy(() => `http://127.0.0.1:${proxy.port}`);

		const response = await fetch(
			`http://127.0.0.1:${localServer.port}/anything`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-marker")).toBe("local");
		expect(proxy.requestLines.length).toBe(0);
	});

	it("excludes any 127.0.0.0/8 address from proxying", async () => {
		const proxy = startFakeProxy();
		cleanups.push(() => proxy.server.stop(true));

		installOutboundProxy(() => `http://127.0.0.1:${proxy.port}`);

		// 127.0.0.2 has no route on most machines (no loopback alias configured),
		// so the direct request is expected to fail/time out — what matters is
		// that the fake proxy never sees it, proving the exemption kicked in
		// before any connection attempt was routed through the proxy.
		try {
			await fetch("http://127.0.0.2:1/", { signal: AbortSignal.timeout(500) });
		} catch {
			// Expected: no route to 127.0.0.2 on this host.
		}
		expect(proxy.requestLines.length).toBe(0);
	});

	it("is a no-op when the resolver returns undefined", async () => {
		const proxy = startFakeProxy();
		cleanups.push(() => proxy.server.stop(true));

		const localServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response("local-ok", { status: 200 });
			},
		});
		cleanups.push(() => localServer.stop(true));

		installOutboundProxy(() => undefined);

		const response = await fetch(`http://127.0.0.1:${localServer.port}/`);
		expect(response.status).toBe(200);
		expect(proxy.requestLines.length).toBe(0);
	});

	it("never overrides a caller-supplied proxy option", async () => {
		const proxyA = startFakeProxy();
		cleanups.push(() => proxyA.server.stop(true));
		const proxyB = startFakeProxy();
		cleanups.push(() => proxyB.server.stop(true));

		installOutboundProxy(() => `http://127.0.0.1:${proxyA.port}`);

		const response = await fetch("https://outbound-proxy-test.invalid/y", {
			proxy: `http://127.0.0.1:${proxyB.port}`,
		} satisfies FetchInitWithProxy);

		expect(response.status).toBe(502);
		expect(proxyB.requestLines.length).toBeGreaterThan(0);
		expect(proxyA.requestLines.length).toBe(0);
	});
});
