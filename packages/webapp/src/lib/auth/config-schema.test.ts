import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_SCOPES,
  normalizeConfig,
  stripScheme,
  type AppConfig,
} from "./config-schema.js";

describe("stripScheme", () => {
  it("removes https/http schemes and trailing slashes", () => {
    expect(stripScheme("https://auth.example.com/")).toBe("auth.example.com");
    expect(stripScheme("http://auth.example.com")).toBe("auth.example.com");
    expect(stripScheme("auth.example.com")).toBe("auth.example.com");
  });

  it("never leaves a scheme or trailing slash for arbitrary hosts", () => {
    fc.assert(
      fc.property(
        fc.domain(),
        fc.constantFrom("https://", "http://", ""),
        fc.constantFrom("", "/", "//"),
        (host, scheme, trailing) => {
          const result = stripScheme(`${scheme}${host}${trailing}`);
          expect(result).not.toMatch(/^https?:\/\//i);
          expect(result.endsWith("/")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("normalizeConfig", () => {
  const valid: AppConfig = {
    cognito: {
      hostedUiDomain: "https://auth.example.com/",
      clientId: "client-1",
    },
  };

  it("strips the scheme from hostedUiDomain and applies default scopes", () => {
    const normalized = normalizeConfig(valid);
    expect(normalized.cognito.hostedUiDomain).toBe("auth.example.com");
    expect(normalized.cognito.scopes).toEqual(DEFAULT_SCOPES);
  });

  it("preserves explicitly provided scopes", () => {
    const normalized = normalizeConfig({
      cognito: { ...valid.cognito, scopes: ["openid"] },
    });
    expect(normalized.cognito.scopes).toEqual(["openid"]);
  });

  it("throws when hostedUiDomain is missing", () => {
    expect(() =>
      normalizeConfig({ cognito: { clientId: "c" } } as unknown as AppConfig),
    ).toThrow(/hostedUiDomain/);
  });

  it("throws when clientId is missing or empty", () => {
    expect(() =>
      normalizeConfig({
        cognito: { hostedUiDomain: "auth.example.com", clientId: "" },
      }),
    ).toThrow(/clientId/);
  });
});
