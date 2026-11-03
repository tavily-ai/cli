import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  buildAuthorizeUrl,
  expiresAtFromNow,
  fetchMetadata,
  generatePkce,
  looksHeadless,
  type OAuthMetadata,
  type RegisteredClient,
  refreshTokens,
  registerClient,
  revokeToken,
  tokenIsExpired,
} from "../src/core/oauth.js";
import { OAuthError } from "../src/errors.js";

const metadata = (over: Partial<OAuthMetadata> = {}): OAuthMetadata => ({
  authorizationEndpoint: "https://mcp.tavily.com/authorize",
  tokenEndpoint: "https://mcp.tavily.com/token",
  registrationEndpoint: "https://mcp.tavily.com/register",
  revocationEndpoint: null,
  resource: "https://mcp.tavily.com/mcp",
  ...over,
});

const publicClient: RegisteredClient = {
  clientId: "cid",
  clientSecret: null,
  tokenEndpointAuthMethod: "none",
  redirectUri: "http://127.0.0.1:1/callback",
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const stub = (handler: Handler) =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  ) as unknown as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("pkce is S256 and unpadded", () => {
  const { verifier, challenge } = generatePkce();
  expect(verifier.length).toBeGreaterThanOrEqual(43);
  expect(verifier.length).toBeLessThanOrEqual(128);
  expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
  expect(challenge).toBe(expected);
  expect(challenge).not.toContain("=");
});

test("token expiry skew", () => {
  const now = 1_000_000;
  const expiresAt = expiresAtFromNow(3600, now);
  expect(expiresAt).toBe(now + 3600 - 60);
  expect(tokenIsExpired(expiresAt, now)).toBe(false);
  expect(tokenIsExpired(expiresAt, expiresAt)).toBe(true);
  expect(tokenIsExpired(null)).toBe(true);
  expect(expiresAtFromNow(undefined, now)).toBe(now + 3600 - 60);
  expect(expiresAtFromNow(-5, now)).toBe(now + 3600 - 60);
});

test.each([
  ["bad"],
  [true],
  [[]],
  [{}],
  [Number.NaN],
  [Number.POSITIVE_INFINITY],
  [Number.NEGATIVE_INFINITY],
])("malformed token expiry %j is expired", (expiresAt) => {
  expect(tokenIsExpired(expiresAt)).toBe(true);
});

test("authorize url includes pkce and resource", () => {
  const url = buildAuthorizeUrl(
    metadata(),
    { ...publicClient, clientId: "cli-1", redirectUri: "http://127.0.0.1:9999/callback" },
    { state: "st", codeChallenge: "ch" },
  );
  expect(url.startsWith("https://mcp.tavily.com/authorize?")).toBe(true);
  expect(url).toContain("client_id=cli-1");
  expect(url).toContain("code_challenge=ch");
  expect(url).toContain("code_challenge_method=S256");
  expect(url).toContain("state=st");
  expect(url).toContain("resource=https%3A%2F%2Fmcp.tavily.com%2Fmcp");
  expect(
    url.includes("scope=openid+offline_access") || url.includes("scope=openid%20offline_access"),
  ).toBe(true);
});

describe("registerClient", () => {
  test("public pkce", async () => {
    const f = stub((url, init) => {
      expect(url).toBe("https://mcp.tavily.com/register");
      const body = String(init.body);
      expect(body).toContain("token_endpoint_auth_method");
      expect(body).toContain("Tavily CLI");
      return json({ client_id: "cid-1", token_endpoint_auth_method: "none" }, 201);
    });
    const registered = await registerClient(metadata(), "http://127.0.0.1:1/callback", f);
    expect(registered.clientId).toBe("cid-1");
    expect(registered.clientSecret).toBeNull();
    expect(registered.tokenEndpointAuthMethod).toBe("none");
  });

  test("rejects http errors", async () => {
    const f = stub(() => new Response("invalid redirect", { status: 400 }));
    await expect(registerClient(metadata(), "http://127.0.0.1:1/callback", f)).rejects.toThrow(
      /Client registration failed/,
    );
  });

  test.each([
    ["html", "OAuth client registration returned invalid JSON"],
    ["list", "expected a JSON object"],
    ["missing_client_id", "did not return a client_id"],
  ])("normalizes malformed success response %s", async (kind, expected) => {
    const f = stub(() => {
      if (kind === "html")
        return new Response("<html>temporary proxy error</html>", { status: 200 });
      if (kind === "list") return json(["not", "an", "object"]);
      return json({});
    });
    const p = registerClient(metadata(), "http://127.0.0.1:1/callback", f);
    await expect(p).rejects.toThrow(OAuthError);
    await expect(p).rejects.toThrow(expected);
  });

  test("rejects invalid confidential client secret", async () => {
    const f = stub(() =>
      json({
        client_id: "cid",
        client_secret: 123,
        token_endpoint_auth_method: "client_secret_post",
      }),
    );
    await expect(registerClient(metadata(), "http://127.0.0.1:1/callback", f)).rejects.toThrow(
      /issued no valid client_secret/,
    );
  });

  test("rejects unsupported auth method and wraps network errors", async () => {
    const f = stub(() => json({ client_id: "cid", token_endpoint_auth_method: "private_key_jwt" }));
    await expect(registerClient(metadata(), "http://x/cb", f)).rejects.toThrow(
      /unsupported token_endpoint_auth_method 'private_key_jwt'/,
    );
    const down = stub(() => {
      throw new TypeError("fetch failed");
    });
    await expect(registerClient(metadata(), "http://x/cb", down)).rejects.toThrow(
      /Could not reach the Tavily OAuth server: fetch failed/,
    );
  });
});

describe("fetchMetadata", () => {
  const discovery = {
    issuer: "https://mcp.tavily.com/",
    authorization_endpoint: "https://mcp.tavily.com/authorize",
    token_endpoint: "https://mcp.tavily.com/token",
    registration_endpoint: "https://mcp.tavily.com/register",
    revocation_endpoint: "https://mcp.tavily.com/revoke",
  };

  test("uses discovery", async () => {
    const f = stub((url) => {
      if (url.endsWith("oauth-authorization-server")) return json(discovery);
      if (url.endsWith("oauth-protected-resource/mcp"))
        return json({ resource: "https://mcp.tavily.com/mcp" });
      return new Response(null, { status: 404 });
    });
    const meta = await fetchMetadata(f);
    expect(meta.authorizationEndpoint).toBe("https://mcp.tavily.com/authorize");
    expect(meta.resource).toBe("https://mcp.tavily.com/mcp");
  });

  test("falls back to static endpoints when discovery fails", async () => {
    const f = stub(() => new Response("<html>", { status: 500 }));
    const meta = await fetchMetadata(f);
    expect(meta.tokenEndpoint).toBe("https://mcp.tavily.com/token");
    expect(meta.revocationEndpoint).toBe("https://mcp.tavily.com/revoke");
    const down = stub(() => {
      throw new TypeError("offline");
    });
    expect((await fetchMetadata(down)).registrationEndpoint).toBe(
      "https://mcp.tavily.com/register",
    );
  });

  test.each([
    ["issuer", "https://attacker.example/", "issuer does not match"],
    ["token_endpoint", "http://mcp.tavily.com/token", "invalid token_endpoint"],
    [
      "registration_endpoint",
      "https://user:pass@mcp.tavily.com/register",
      "invalid registration_endpoint",
    ],
  ])("rejects untrusted authorization metadata %s", async (field, value, expected) => {
    const body = { ...discovery, [field]: value };
    const f = stub((url) =>
      url.endsWith("oauth-authorization-server")
        ? json(body)
        : json({ resource: "https://mcp.tavily.com/mcp" }),
    );
    const p = fetchMetadata(f);
    await expect(p).rejects.toThrow(OAuthError);
    await expect(p).rejects.toThrow(expected);
  });

  test("rejects different protected resource", async () => {
    const { revocation_endpoint: _omit, ...noRevoke } = discovery;
    const f = stub((url) =>
      url.endsWith("oauth-authorization-server")
        ? json(noRevoke)
        : json({ resource: "https://attacker.example/mcp" }),
    );
    await expect(fetchMetadata(f)).rejects.toThrow(/does not match the Tavily MCP resource/);
  });
});

describe("tokens", () => {
  test("refresh keeps refresh token if omitted", async () => {
    const f = stub((_url, init) => {
      expect(String(init.body)).toContain("grant_type=refresh_token");
      expect((init.headers as Record<string, string>)["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      return json({ access_token: "new-access", expires_in: 3600 });
    });
    const tokens = await refreshTokens(metadata(), publicClient, "old-refresh", f);
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("old-refresh");
    expect(tokens.tokenType).toBe("Bearer");
  });

  test("client_secret_basic sends Authorization header and no client_id in body", async () => {
    const f = stub((_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
      expect(String(init.body)).not.toContain("client_id");
      return json({ access_token: "a" });
    });
    await refreshTokens(
      metadata(),
      { ...publicClient, clientSecret: "sec", tokenEndpointAuthMethod: "client_secret_basic" },
      "r",
      f,
    );
  });

  test.each([
    ["html", "OAuth token endpoint returned invalid JSON"],
    ["list", "expected a JSON object"],
    ["missing_access_token", "did not include a valid access_token"],
  ])("normalizes malformed success response %s", async (kind, expected) => {
    const f = stub(() => {
      if (kind === "html")
        return new Response("<html>temporary proxy error</html>", { status: 200 });
      if (kind === "list") return json(["not", "an", "object"]);
      return json({});
    });
    const p = refreshTokens(metadata(), publicClient, "old-refresh", f);
    await expect(p).rejects.toThrow(OAuthError);
    await expect(p).rejects.toThrow(expected);
  });

  test("http error message includes truncated detail", async () => {
    const f = stub(() => new Response(`${"x".repeat(400)}\nz`, { status: 401 }));
    await expect(refreshTokens(metadata(), publicClient, "r", f)).rejects.toThrow(
      `Token request failed (HTTP 401): ${"x".repeat(277)}...`,
    );
  });
});

describe("revokeToken", () => {
  const revokeMeta = metadata({ revocationEndpoint: "https://mcp.tavily.com/revoke" });
  const bodies: Record<string, string>[] = [];
  const record = (init: RequestInit) => {
    bodies.push(Object.fromEntries(new URLSearchParams(String(init.body))));
  };

  test("public client uses standard request first", async () => {
    bodies.length = 0;
    const f = stub((_u, init) => {
      record(init);
      return new Response(null, { status: 200 });
    });
    await revokeToken(revokeMeta, publicClient, "refresh-1", { tokenTypeHint: "refresh_token" }, f);
    expect(bodies).toEqual([
      { token: "refresh-1", token_type_hint: "refresh_token", client_id: "cid" },
    ]);
  });

  test("public client retries known 400 with empty secret", async () => {
    bodies.length = 0;
    const f = stub((_u, init) => {
      record(init);
      return bodies.length === 1
        ? json({ error: "invalid_request" }, 400)
        : new Response(null, { status: 200 });
    });
    await revokeToken(revokeMeta, publicClient, "refresh-1", { tokenTypeHint: "refresh_token" }, f);
    expect(bodies[0]).not.toHaveProperty("client_secret");
    expect(bodies[1]?.client_secret).toBe("");
    expect(bodies[1]?.client_id).toBe("cid");
  });

  test("raises after failed compatibility retry", async () => {
    const f = stub(() => json({ error: "invalid_request" }, 400));
    await expect(
      revokeToken(revokeMeta, publicClient, "refresh-1", { tokenTypeHint: "refresh_token" }, f),
    ).rejects.toThrow(/Token revocation failed \(HTTP 400\)/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("empty token is a no-op and missing endpoint raises", async () => {
    const f = stub(() => new Response(null, { status: 200 }));
    await revokeToken(revokeMeta, publicClient, "", { tokenTypeHint: "access_token" }, f);
    expect(f).not.toHaveBeenCalled();
    await expect(
      revokeToken(metadata(), publicClient, "t", { tokenTypeHint: "access_token" }, f),
    ).rejects.toThrow(/does not advertise a token revocation endpoint/);
  });
});

test("looksHeadless", () => {
  expect(looksHeadless({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(true);
  expect(looksHeadless({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(true);
  expect(looksHeadless({}, "linux")).toBe(true);
  expect(looksHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
  expect(looksHeadless({ WAYLAND_DISPLAY: "w0" }, "linux")).toBe(false);
  expect(looksHeadless({}, "darwin")).toBe(false);
});

describe("transport safety", () => {
  test("redirects are not followed and are errors", async () => {
    const f = stub(
      () => new Response(null, { status: 307, headers: { location: "http://evil.example/" } }),
    );
    await expect(refreshTokens(metadata(), publicClient, "r", f)).rejects.toThrow(OAuthError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(
      (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[1].redirect,
    ).toBe("manual");
    const g = stub(
      () => new Response(null, { status: 307, headers: { location: "http://evil.example/" } }),
    );
    await expect(
      revokeToken(
        metadata({ revocationEndpoint: "https://mcp.tavily.com/revoke" }),
        publicClient,
        "t",
        { tokenTypeHint: "access_token" },
        g,
      ),
    ).rejects.toThrow(OAuthError);
    expect(g).toHaveBeenCalledTimes(1);
  });

  test("discovery treats a redirect as failure and falls back", async () => {
    const f = stub(
      () => new Response(null, { status: 302, headers: { location: "http://evil.example/" } }),
    );
    expect((await fetchMetadata(f)).tokenEndpoint).toBe("https://mcp.tavily.com/token");
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("body read failure maps to Could not reach", async () => {
    const broken = () => {
      const r = new Response("x", { status: 200 });
      r.text = () =>
        Promise.reject(new TypeError("terminated", { cause: new Error("socket hang up") }));
      return r;
    };
    await expect(refreshTokens(metadata(), publicClient, "r", stub(broken))).rejects.toThrow(
      /Could not reach the Tavily OAuth server: terminated: socket hang up/,
    );
    const brokenErr = () => {
      const r = new Response("x", { status: 500 });
      r.text = () => Promise.reject(new TypeError("terminated"));
      return r;
    };
    await expect(refreshTokens(metadata(), publicClient, "r", stub(brokenErr))).rejects.toThrow(
      /Could not reach the Tavily OAuth server/,
    );
  });
});
