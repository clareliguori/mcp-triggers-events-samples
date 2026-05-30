/**
 * Client-side encryption helpers for the per-subscription webhook secret.
 *
 * The MCP Events extension uses a per-subscription Standard Webhooks `whsec_`
 * secret. The plaintext secret only ever travels in `delivery.secret` over TLS
 * and is used in memory to sign/verify deliveries. At rest, the secret is
 * client-side encrypted with a customer-managed KMS key BEFORE being written to
 * DynamoDB, so the storage service only ever holds ciphertext.
 *
 * Key ownership is per Subscriptions table (each owned by the service that owns
 * the table):
 * - Data API Subscriptions table key — used by the Subscription Manager
 *   (encrypt on store / decrypt on refresh) and the Webhook Receiver (decrypt to
 *   verify).
 * - USGS server Subscriptions table key — used by MCP Server 1.
 * - Scheduler server Subscriptions table key — used by MCP Server 2.
 *
 * The `whsec_` secret is ~50 bytes, far under the 4 KB KMS `Encrypt` limit, so
 * the value is encrypted directly with `kms:Encrypt` (no envelope encryption
 * needed). Each ciphertext is bound to its `subscriptionId` via a KMS
 * encryption context so a ciphertext copied to a different subscription fails to
 * decrypt.
 */

import {
  DecryptCommand,
  EncryptCommand,
  type KMSClient,
} from "@aws-sdk/client-kms";

/** Encryption-context key that binds a secret ciphertext to its subscription. */
export const SUBSCRIPTION_ID_ENCRYPTION_CONTEXT_KEY = "subscriptionId";

/**
 * Builds the KMS encryption context for a subscription secret. The same context
 * must be supplied on encrypt and decrypt, which cryptographically binds the
 * ciphertext to `subscriptionId`.
 */
export function secretEncryptionContext(
  subscriptionId: string,
): Record<string, string> {
  return { [SUBSCRIPTION_ID_ENCRYPTION_CONTEXT_KEY]: subscriptionId };
}

/**
 * Client-side encrypts a plaintext `whsec_` secret with the given KMS key,
 * returning base64-encoded ciphertext suitable for storing as a DynamoDB
 * string attribute.
 *
 * @param kms - A KMS client.
 * @param keyId - The customer-managed key id or ARN to encrypt under.
 * @param subscriptionId - Bound into the KMS encryption context.
 * @param plaintextSecret - The `whsec_` secret to encrypt.
 */
export async function encryptSubscriptionSecret(
  kms: KMSClient,
  keyId: string,
  subscriptionId: string,
  plaintextSecret: string,
): Promise<string> {
  const result = await kms.send(
    new EncryptCommand({
      KeyId: keyId,
      Plaintext: new TextEncoder().encode(plaintextSecret),
      EncryptionContext: secretEncryptionContext(subscriptionId),
    }),
  );
  if (!result.CiphertextBlob) {
    throw new Error("KMS Encrypt returned no ciphertext");
  }
  return Buffer.from(result.CiphertextBlob).toString("base64");
}

/**
 * Client-side decrypts a base64-encoded ciphertext produced by
 * {@link encryptSubscriptionSecret}, returning the plaintext `whsec_` secret.
 *
 * The KMS key is identified by the ciphertext itself; the same encryption
 * context (bound to `subscriptionId`) must be supplied or decryption fails.
 */
export async function decryptSubscriptionSecret(
  kms: KMSClient,
  subscriptionId: string,
  encryptedSecret: string,
): Promise<string> {
  const result = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(encryptedSecret, "base64"),
      EncryptionContext: secretEncryptionContext(subscriptionId),
    }),
  );
  if (!result.Plaintext) {
    throw new Error("KMS Decrypt returned no plaintext");
  }
  return new TextDecoder().decode(result.Plaintext);
}
