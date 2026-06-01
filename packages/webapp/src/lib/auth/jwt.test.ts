import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeJwt, isExpired } from "./jwt.js";

/** Build an unsigned JWT (header.payload.signature) with base64url segments. */
function makeJwt(payload: Record<string, unknown>, signature = "sig"): string {
  const enc = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.${signature}`;
}

describe("decodeJwt", () => {
  it("extracts the sub claim (customerId) from a well-formed token", () => {
    const token = makeJwt({
      sub: "11111111-2222-3333-4444-555555555555",
      email: "a@b.co",
    });
    const claims = decodeJwt(token);
    expect(claims?.sub).toBe("11111111-2222-3333-4444-555555555555");
    expect(claims?.email).toBe("a@b.co");
  });

  it("returns null for a token without three segments", () => {
    expect(decodeJwt("not-a-jwt")).toBeNull();
    expect(decodeJwt("only.two")).toBeNull();
  });

  it("returns null when the payload is not valid JSON", () => {
    expect(decodeJwt("aaa.@@@notbase64json@@@.sig")).toBeNull();
  });

  it("returns null when the sub claim is missing or empty", () => {
    expect(decodeJwt(makeJwt({ email: "a@b.co" }))).toBeNull();
    expect(decodeJwt(makeJwt({ sub: "" }))).toBeNull();
  });

  it("round-trips an arbitrary non-empty sub through decode", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 64 })
          .filter((s) => s.trim().length > 0),
        fc.integer({ min: 0, max: 4_000_000_000 }),
        (sub, exp) => {
          const claims = decodeJwt(makeJwt({ sub, exp }));
          expect(claims?.sub).toBe(sub);
          expect(claims?.exp).toBe(exp);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("isExpired", () => {
  const now = 1_700_000_000_000; // fixed ms epoch

  it("treats tokens without exp as non-expiring", () => {
    expect(isExpired({ sub: "x" }, 30, now)).toBe(false);
  });

  it("reports expiry within the skew window", () => {
    const exp = Math.floor(now / 1000) + 10; // 10s out, inside 30s skew
    expect(isExpired({ sub: "x", exp }, 30, now)).toBe(true);
  });

  it("reports valid for tokens beyond the skew window", () => {
    const exp = Math.floor(now / 1000) + 600; // 10 min out
    expect(isExpired({ sub: "x", exp }, 30, now)).toBe(false);
  });
});
