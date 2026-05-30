/**
 * Unit tests for the subscription-secret client-side encryption helpers.
 *
 * These use a lightweight fake KMS client (rather than the network) to verify:
 * - encrypt then decrypt round-trips the plaintext secret,
 * - the subscriptionId is carried in the KMS encryption context,
 * - decrypt with a mismatched encryption context (wrong subscriptionId) fails,
 *   mirroring real KMS behavior.
 */

import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_ID_ENCRYPTION_CONTEXT_KEY,
  decryptSubscriptionSecret,
  encryptSubscriptionSecret,
  secretEncryptionContext,
} from "./crypto.js";

/**
 * Minimal fake of the KMS client `send` surface used by the helpers. The
 * "ciphertext" embeds the plaintext and the encryption context as JSON so the
 * fake can enforce the same context-binding guarantee real KMS provides.
 */
function makeFakeKms() {
  return {
    send: async (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      const name = command.constructor.name;
      if (name === "EncryptCommand") {
        const input = command.input as {
          KeyId: string;
          Plaintext: Uint8Array;
          EncryptionContext?: Record<string, string>;
        };
        const envelope = JSON.stringify({
          keyId: input.KeyId,
          plaintext: Buffer.from(input.Plaintext).toString("utf8"),
          context: input.EncryptionContext ?? {},
        });
        return {
          CiphertextBlob: new TextEncoder().encode(envelope),
        };
      }
      if (name === "DecryptCommand") {
        const input = command.input as {
          CiphertextBlob: Uint8Array;
          EncryptionContext?: Record<string, string>;
        };
        const envelope = JSON.parse(
          new TextDecoder().decode(input.CiphertextBlob),
        ) as { plaintext: string; context: Record<string, string> };
        // Real KMS fails if the encryption context does not match exactly.
        const supplied = JSON.stringify(input.EncryptionContext ?? {});
        const expected = JSON.stringify(envelope.context);
        if (supplied !== expected) {
          throw new Error(
            "InvalidCiphertextException: encryption context mismatch",
          );
        }
        return {
          Plaintext: new TextEncoder().encode(envelope.plaintext),
        };
      }
      throw new Error(`unexpected command ${name}`);
    },
     
  } as any;
}

describe("subscription secret crypto", () => {
  const keyId = "arn:aws:kms:us-west-2:111122223333:key/abc";
  const subscriptionId = "11111111-1111-4111-8111-111111111111";
  const secret = `whsec_${"A".repeat(43)}=`;

  it("round-trips a secret through encrypt then decrypt", async () => {
    const kms = makeFakeKms();
    const ciphertext = await encryptSubscriptionSecret(
      kms,
      keyId,
      subscriptionId,
      secret,
    );
    expect(ciphertext).not.toContain(secret); // stored value is not plaintext
    const recovered = await decryptSubscriptionSecret(
      kms,
      subscriptionId,
      ciphertext,
    );
    expect(recovered).toBe(secret);
  });

  it("binds the ciphertext to the subscriptionId via encryption context", async () => {
    const kms = makeFakeKms();
    const ciphertext = await encryptSubscriptionSecret(
      kms,
      keyId,
      subscriptionId,
      secret,
    );
    // Decrypting under a different subscriptionId must fail.
    await expect(
      decryptSubscriptionSecret(
        kms,
        "22222222-2222-4222-8222-222222222222",
        ciphertext,
      ),
    ).rejects.toThrow();
  });

  it("exposes a stable encryption-context shape", () => {
    expect(secretEncryptionContext(subscriptionId)).toEqual({
      [SUBSCRIPTION_ID_ENCRYPTION_CONTEXT_KEY]: subscriptionId,
    });
  });
});
