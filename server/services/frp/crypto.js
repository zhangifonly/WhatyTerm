/**
 * FRP Control Connection Encryption
 *
 * FRP uses AES-128-CFB encryption on the control connection after Login.
 * - Login message is sent in plaintext
 * - All subsequent messages (NewProxy, Ping, ReqWorkConn, etc.) are encrypted
 *
 * Encryption details:
 * - Algorithm: AES-128-CFB
 * - Key derivation: PBKDF2(token, "frp", 64 iterations, 16 bytes, SHA1)
 * - IV: Random 16 bytes, sent as first 16 bytes of encrypted stream
 *
 * Note: The salt is "frp", not "crypto" as documented in golib/crypto.
 * This was discovered by testing against actual frps server.
 */

import crypto from 'crypto';

// FRP server uses "frp" as salt (discovered by testing)
const DEFAULT_SALT = 'frp';
const AES_BLOCK_SIZE = 16;
const PBKDF2_ITERATIONS = 64;

/**
 * Derive encryption key from token using PBKDF2
 * @param {string|Buffer} token - Authentication token
 * @returns {Buffer} - 16-byte AES key
 */
export function deriveKey(token) {
  const tokenBuffer = Buffer.isBuffer(token) ? token : Buffer.from(token, 'utf8');
  return crypto.pbkdf2Sync(tokenBuffer, DEFAULT_SALT, PBKDF2_ITERATIONS, AES_BLOCK_SIZE, 'sha1');
}

/**
 * CryptoWriter - Encrypts data using AES-128-CFB
 *
 * First write sends IV (16 bytes) followed by encrypted data.
 * Subsequent writes send only encrypted data.
 */
export class CryptoWriter {
  /**
   * @param {Buffer} key - 16-byte AES key (from deriveKey)
   */
  constructor(key) {
    this.key = key;
    this.iv = crypto.randomBytes(AES_BLOCK_SIZE);
    this.cipher = crypto.createCipheriv('aes-128-cfb', key, this.iv);
    this.ivSent = false;
  }

  /**
   * Encrypt data
   * @param {Buffer} data - Plaintext data
   * @returns {Buffer} - Encrypted data (with IV prepended on first call)
   */
  write(data) {
    const encrypted = this.cipher.update(data);

    if (!this.ivSent) {
      this.ivSent = true;
      return Buffer.concat([this.iv, encrypted]);
    }

    return encrypted;
  }
}

/**
 * CryptoReader - Decrypts data using AES-128-CFB
 *
 * First read extracts IV (16 bytes) from the beginning of the stream.
 * Subsequent reads decrypt the data.
 */
export class CryptoReader {
  /**
   * @param {Buffer} key - 16-byte AES key (from deriveKey)
   */
  constructor(key) {
    this.key = key;
    this.decipher = null;
    this.ivBuffer = Buffer.alloc(0);
  }

  /**
   * Decrypt data
   * @param {Buffer} data - Encrypted data
   * @returns {Buffer} - Decrypted data (may be empty if still collecting IV)
   */
  read(data) {
    if (!this.decipher) {
      // Still collecting IV
      this.ivBuffer = Buffer.concat([this.ivBuffer, data]);

      if (this.ivBuffer.length >= AES_BLOCK_SIZE) {
        // Got enough for IV
        const iv = this.ivBuffer.slice(0, AES_BLOCK_SIZE);
        this.decipher = crypto.createDecipheriv('aes-128-cfb', this.key, iv);

        // Decrypt any remaining data after IV
        const remaining = this.ivBuffer.slice(AES_BLOCK_SIZE);
        this.ivBuffer = null; // Free memory

        if (remaining.length > 0) {
          return this.decipher.update(remaining);
        }
        return Buffer.alloc(0);
      }

      // Need more data for IV
      return Buffer.alloc(0);
    }

    // Normal decryption
    return this.decipher.update(data);
  }

  /**
   * Check if IV has been received and decryption is ready
   * @returns {boolean}
   */
  isReady() {
    return this.decipher !== null;
  }
}

/**
 * Encrypt a single buffer (for one-shot encryption)
 * @param {Buffer} data - Plaintext data
 * @param {Buffer} key - 16-byte AES key
 * @returns {Buffer} - IV + encrypted data
 */
export function encrypt(data, key) {
  const iv = crypto.randomBytes(AES_BLOCK_SIZE);
  const cipher = crypto.createCipheriv('aes-128-cfb', key, iv);
  const encrypted = cipher.update(data);
  return Buffer.concat([iv, encrypted, cipher.final()]);
}

/**
 * Decrypt a single buffer (for one-shot decryption)
 * @param {Buffer} data - IV + encrypted data
 * @param {Buffer} key - 16-byte AES key
 * @returns {Buffer} - Decrypted data
 */
export function decrypt(data, key) {
  if (data.length < AES_BLOCK_SIZE) {
    throw new Error('Ciphertext too short');
  }

  const iv = data.slice(0, AES_BLOCK_SIZE);
  const ciphertext = data.slice(AES_BLOCK_SIZE);
  const decipher = crypto.createDecipheriv('aes-128-cfb', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
