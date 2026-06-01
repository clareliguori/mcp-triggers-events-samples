import { describe, expect, it, vi } from "vitest";
import type { CognitoConfig } from "./config-schema.js";
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  refreshTokens,
} from "./cognito.js";

const config: CognitoConfig = {
  hostedUiDomain: "auth.earthquake-agent.example.com",
  clientId: "client-123",
  scopes: ["openid", "email", "profile"],
};

describe("buildAuthorizeUrl", () => {
  it("builds an authorization-code + PKCE (S256) authorize URL", () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        codeChallenge: "challenge-abc",
        state: "state-xyz",
        redirectUri: "https://app.example.com/",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.earthquake-agent.example.com/oauth2/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/",
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("routes to the Hosted UI signup page when signUp is set", () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        codeChallenge: "c",
        state: "s",
        redirectUri: "https://app.example.com/",
        signUp: true,
      }),
    );
    expect(url.pathname).toBe("/signup");
  });

  it("prefers an explicit configured redirectUri over the argument", () => {
    const url = new URL(
      buildAuthorizeUrl(
        { ...config, redirectUri: "https://configured.example.com/" },
        {
          codeChallenge: "c",
          state: "s",
          redirectUri: "https://arg.example.com/",
        },
      ),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://configured.example.com/",
    );
  });
});

describe("buildLogoutUrl", () => {
  it("builds a logout URL with client_id and logout_uri", () => {
    const url = new URL(
      buildLogoutUrl(config, { logoutUri: "https://app.example.com/" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.earthquake-agent.example.com/logout",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("logout_uri")).toBe("https://app.example.com/");
  });
});

describe("exchangeCodeForTokens", () => {
  it("POSTs the authorization_code grant with the PKCE verifier", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id_token: "id.tok.en",
            access_token: "acc.tok.en",
            refresh_token: "refresh-tok",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const tokens = await exchangeCodeForTokens(
      config,
      {
        code: "auth-code",
        codeVerifier: "verifier",
        redirectUri: "https://app.example.com/",
      },
      fetchFn as unknown as typeof fetch,
    );

    expect(tokens.idToken).toBe("id.tok.en");
    expect(tokens.accessToken).toBe("acc.tok.en");
    expect(tokens.refreshToken).toBe("refresh-tok");

    const [calledUrl, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      "https://auth.earthquake-agent.example.com/oauth2/token",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier");
  });

  it("throws with the error_description on a token endpoint failure", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "bad code",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      exchangeCodeForTokens(
        config,
        {
          code: "x",
          codeVerifier: "v",
          redirectUri: "https://app.example.com/",
        },
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow("bad code");
  });
});

describe("refreshTokens", () => {
  it("POSTs the refresh_token grant and retains the original refresh token", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id_token: "id2",
            access_token: "acc2",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const tokens = await refreshTokens(
      config,
      "the-refresh-token",
      fetchFn as unknown as typeof fetch,
    );

    expect(tokens.accessToken).toBe("acc2");
    // Cognito does not return a new refresh token on refresh; keep the old one.
    expect(tokens.refreshToken).toBe("the-refresh-token");

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("the-refresh-token");
  });
});
