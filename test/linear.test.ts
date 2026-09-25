import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { LinearClient } from "../src/linear.js";

const appEnv = { LINEAR_CLIENT_ID: "cid", LINEAR_CLIENT_SECRET: "secret", LINEAR_AUTH_MODE: "api_key" } as Env;

describe("Linear app attribution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches one app token, reuses it, and names the Matrix sender", async () => {
    const calls: { url: string; auth?: string; body: string }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        calls.push({ url, auth, body: String(init?.body) });

        if (url.includes("/oauth/token")) {
          return Response.json({ access_token: "app-token", expires_in: 2_592_000 });
        }
        return Response.json({ data: { commentCreate: { success: true, comment: { id: "c1" } } } });
      }),
    );

    await new LinearClient(appEnv).createComment("issue", "hello", "ikkeT");
    await new LinearClient(appEnv).createComment("issue", "again", "ikkeT");

    const tokenCalls = calls.filter((c) => c.url.includes("/oauth/token"));
    const apiCalls = calls.filter((c) => !c.url.includes("/oauth/token"));

    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.body).toContain("grant_type=client_credentials");
    expect(apiCalls.every((c) => c.auth === "Bearer app-token")).toBe(true);
    expect(JSON.parse(apiCalls[0]!.body).variables.input.createAsUser).toBe("ikkeT");
  });
});
