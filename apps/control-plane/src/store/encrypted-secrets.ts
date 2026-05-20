import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const algorithm = 'aes-256-gcm';

export type EncryptedSandboxSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
};

export class SecretCipher {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = createHmac('sha256', secret).update(`deputies:${purpose}`).digest();
  }

  encrypt(value: string): EncryptedSandboxSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv(algorithm, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(secret: EncryptedSandboxSecret): string {
    const decipher = createDecipheriv(algorithm, this.key, Buffer.from(secret.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }
}
