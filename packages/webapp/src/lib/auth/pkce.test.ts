import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  base64UrlEncode,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";

describe("base64UrlEncode", () => {
  it("produces URL-safe output with no padding", () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 191, 0, 16]));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("encodes a known vector correctly", () => {
    // "Man" -> "TWFu" in standard base64 (no padding needed).
    expect(base64UrlEncode(new TextEncoder().encode("Man"))).toBe("TWFu");
  });
});

describe("generateCodeVerifier", () => {
  it("returns a 43-char URL-safe verifier from 32 random bytes", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns distinct values across calls", () => {
    const values = new Set(
      Array.from({ length: 50 }, () => generateCodeVerifier()),
    );
    expect(values.size).toBe(50);
  });
});

describe("generateState", () => {
  it("returns a URL-safe non-empty value", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("deriveCodeChallenge", () => {
  it("matches the RFC 7636 appendix B test vector", async () => {
    // RFC 7636 Appendix B sample verifier and its S256 challenge.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("is deterministic for a given verifier", async () => {
    const verifier = generateCodeVerifier();
    const a = await deriveCodeChallenge(verifier);
    const b = await deriveCodeChallenge(verifier);
    expect(a).toBe(b);
  });

  it("produces a URL-safe, unpadded challenge for arbitrary verifiers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 43, maxLength: 128 }),
        async (verifier) => {
          const challenge = await deriveCodeChallenge(verifier);
          // SHA-256 -> 32 bytes -> 43 base64url chars (no padding).
          expect(challenge).toHaveLength(43);
          expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
        },
      ),
      { numRuns: 100 },
    );
  });
});
