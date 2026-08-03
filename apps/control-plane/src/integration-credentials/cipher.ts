import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type CredentialIdentity = {
  id: string;
  scope: 'tenant';
  namespace: string;
  name: string;
  payloadSchema: string;
  payloadVersion: number;
};
export type EncryptedCredentialPayload = {
  encryptionVersion: 1;
  encryptionKeyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export class IntegrationCredentialCipher {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: ReadonlyMap<string, Buffer>,
  ) {
    if (!activeKeyId || !keys.has(activeKeyId))
      throw new Error('Integration credential active key ID is missing from keyring');
    for (const [id, key] of keys) {
      if (!id.trim() || key.length !== 32)
        throw new Error('Integration credential keyring contains an invalid key ID or key length');
    }
  }

  encrypt(identity: CredentialIdentity, plaintext: Uint8Array): EncryptedCredentialPayload {
    if (!plaintext.byteLength || plaintext.byteLength > 65_536)
      throw new Error('Integration credential plaintext size is invalid');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, nonce, { authTagLength: 16 });
    cipher.setAAD(this.aad(identity, 1, this.activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { encryptionVersion: 1, encryptionKeyId: this.activeKeyId, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  decrypt(identity: CredentialIdentity, encrypted: EncryptedCredentialPayload): Uint8Array {
    if (encrypted.encryptionVersion !== 1) throw new Error('Unsupported integration credential encryption version');
    const key = this.keys.get(encrypted.encryptionKeyId);
    if (!key) throw new Error(`Integration credential encryption key is unavailable: ${encrypted.encryptionKeyId}`);
    if (encrypted.nonce.length !== 12 || encrypted.authTag.length !== 16 || !encrypted.ciphertext.length)
      throw new Error('Integration credential encrypted payload shape is invalid');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce, { authTagLength: 16 });
      decipher.setAAD(this.aad(identity, 1, encrypted.encryptionKeyId));
      decipher.setAuthTag(encrypted.authTag);
      return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    } catch {
      throw new Error('Integration credential authentication failed');
    }
  }

  private aad(identity: CredentialIdentity, version: number, keyId: string): Buffer {
    const id = identity.id.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new Error('Integration credential ID must be a canonical UUID');
    return Buffer.from(
      JSON.stringify([
        'deputies.integration-credential',
        version,
        keyId,
        id,
        identity.scope,
        identity.namespace,
        identity.name,
        identity.payloadSchema,
        identity.payloadVersion,
      ]),
      'utf8',
    );
  }
}

export function parseIntegrationCredentialKeyring(
  activeKeyId: string | undefined,
  json: string | undefined,
): IntegrationCredentialCipher {
  if (!activeKeyId || !json) throw new Error('Integration credential keyring configuration is required');
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEYS must be a JSON object');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEYS must be a JSON object');
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))
      throw new Error('Integration credential keyring values must be base64-encoded 32-byte keys');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error('Integration credential keyring values must decode to 32 bytes');
    keys.set(id, key);
  }
  return new IntegrationCredentialCipher(activeKeyId, keys);
}
