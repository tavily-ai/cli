import type { spawn } from "node:child_process";
import { connect } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { openBrowser, runBrowserLogin } from "../src/core/oauth.js";
import { OAuthError } from "../src/errors.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Discovery 404s (falls back to static endpoints); registration and token are stubbed.
const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/register")) return json({ client_id: "cid" }, 201);
  if (url.endsWith("/token")) return json({ access_token: "tok", expires_in: 3600 });
  return new Response("nope", { status: 404 });
}) as unknown as typeof fetch;

/** Starts a login and resolves once the authorize URL is printed. */
async function start(opts: { timeoutSeconds?: number; openBrowser?: boolean } = {}) {
  let onUrl: (u: string) => void = () => {};
  const urlReady = new Promise<string>((r) => {
    onUrl = r;
  });
  const result = runBrowserLogin({
    openBrowser: false,
    openImpl: () => {},
    onStatus: (u) => onUrl(u),
    fetchImpl,
    ...opts,
  });
  const settled = result.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  );
  const authorizeUrl = new URL(await urlReady);
  const state = authorizeUrl.searchParams.get("state") ?? "";
  const origin = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "").origin;
  return { settled, state, origin };
}

describe("runBrowserLogin", () => {
  test("completes the flow and serves a 200 page", async () => {
    const { settled, state, origin } = await start();
    const resp = await fetch(`${origin}/callback?code=abc&state=${state}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const out = await settled;
    expect(out.ok && out.value.tokens.accessToken).toBe("tok");
  });

  test("rejects a mismatched state", async () => {
    const { settled, origin } = await start();
    await fetch(`${origin}/callback?code=abc&state=wrong`);
    const out = await settled;
    expect(!out.ok && out.error).toEqual(
      new OAuthError("OAuth state mismatch; aborting to prevent CSRF."),
    );
  });

  test("reports a denial with 400", async () => {
    const { settled, origin } = await start();
    const resp = await fetch(`${origin}/callback?error=access_denied`);
    expect(resp.status).toBe(400);
    const out = await settled;
    expect(!out.ok && out.error.message).toBe("Authorization was denied: access_denied");
  });

  test("requires a code", async () => {
    const { settled, state, origin } = await start();
    await fetch(`${origin}/callback?state=${state}`);
    const out = await settled;
    expect(!out.ok && out.error.message).toBe("Authorization callback did not include a code.");
  });

  test("times out", async () => {
    const { settled } = await start({ timeoutSeconds: 0.1 });
    const out = await settled;
    expect(!out.ok && out.error.message).toBe(
      "Timed out after 0.1s waiting for browser authorization. Open the login URL printed above, or use: tvly login --api-key tvly-YOUR_KEY",
    );
  });

  test("survives a malformed request target", async () => {
    const { settled, state, origin } = await start();
    const { port } = new URL(origin);
    const status = await new Promise<string>((resolve) => {
      const sock = connect(Number(port), "127.0.0.1", () =>
        sock.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      );
      let buf = "";
      sock.on("data", (d) => {
        buf += d;
      });
      sock.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
    });
    expect(status).toContain("404");
    await fetch(`${origin}/callback?code=abc&state=${state}`);
    const out = await settled;
    expect(out.ok && out.value.tokens.accessToken).toBe("tok");
  });
});

describe("openBrowser", () => {
  const run = (platform: NodeJS.Platform) => {
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref, on: vi.fn() })) as unknown as typeof spawn;
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    try {
      openBrowser("https://x/y", spawnImpl);
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
    }
    return { spawnImpl, unref };
  };

  test.each([
    ["darwin", "open", ["https://x/y"]],
    ["linux", "xdg-open", ["https://x/y"]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", "https://x/y"]],
  ] as const)("%s", (platform, cmd, args) => {
    const { spawnImpl, unref } = run(platform);
    expect(spawnImpl).toHaveBeenCalledWith(cmd, args, { detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalled();
  });
});
