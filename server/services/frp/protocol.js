/**
 * FRP Protocol Implementation
 *
 * Wire format:
 * - 1 byte: type code
 * - 8 bytes: length (int64, big-endian)
 * - N bytes: JSON content
 *
 * Translated from: github.com/fatedier/frp/pkg/msg
 * and github.com/fatedier/golib/msg/json
 */

import os from 'os';
import crypto from 'crypto';

/**
 * Calculate auth key from token and timestamp
 * This is the same as frp's util.GetAuthKey()
 * @param {string} token
 * @param {number} timestamp
 * @returns {string} MD5 hash in hex
 */
export function getAuthKey(token, timestamp) {
  const md5 = crypto.createHash('md5');
  md5.update(token);
  md5.update(String(timestamp));
  return md5.digest('hex');
}

// Message type codes (from frp/pkg/msg/msg.go)
export const MsgType = {
  Login: 0x6f,              // 'o'
  LoginResp: 0x31,          // '1'
  NewProxy: 0x70,           // 'p'
  NewProxyResp: 0x32,       // '2'
  CloseProxy: 0x63,         // 'c'
  NewWorkConn: 0x77,        // 'w'
  ReqWorkConn: 0x72,        // 'r'
  StartWorkConn: 0x73,      // 's'
  NewVisitorConn: 0x76,     // 'v'
  NewVisitorConnResp: 0x33, // '3'
  Ping: 0x68,               // 'h'
  Pong: 0x34,               // '4'
  UDPPacket: 0x75,          // 'u'
  NatHoleVisitor: 0x69,     // 'i'
  NatHoleClient: 0x6e,      // 'n'
  NatHoleResp: 0x6d,        // 'm'
  NatHoleSid: 0x35,         // '5'
  NatHoleReport: 0x36,      // '6'
};

// Reverse mapping for debugging
export const MsgTypeName = {};
for (const [name, code] of Object.entries(MsgType)) {
  MsgTypeName[code] = name;
}

/**
 * Message Reader - handles TCP stream parsing
 * Accumulates data and extracts complete messages
 *
 * Wire format:
 * - 1 byte: type code
 * - 8 bytes: length (int64, big-endian)
 * - N bytes: JSON content
 */
export class MessageReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Append data to buffer
   * @param {Buffer} data
   */
  append(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  /**
   * Try to read a complete message from buffer
   * @returns {{ type: number, data: object } | null}
   */
  read() {
    // Need at least 9 bytes: 1 (type) + 8 (length)
    if (this.buffer.length < 9) {
      return null;
    }

    const typeCode = this.buffer[0];

    // Check if type code is valid FRP message type
    const validTypes = Object.values(MsgType);
    if (!validTypes.includes(typeCode)) {
      // Skip invalid data - this might be encryption handshake or other non-FRP data
      // Skip the entire buffer if it doesn't start with a valid type
      const nextValidIndex = this._findNextValidType();
      if (nextValidIndex === -1) {
        // No valid type found, clear buffer
        this.buffer = Buffer.alloc(0);
      } else if (nextValidIndex > 0) {
        // Skip to next valid type
        this.buffer = this.buffer.slice(nextValidIndex);
      }
      return null;
    }

    // Read length as int64 big-endian
    const lengthBigInt = this.buffer.readBigInt64BE(1);
    const length = Number(lengthBigInt);

    // Sanity check
    if (length < 0 || length > 10240) {
      // Skip this byte and try again
      this.buffer = this.buffer.slice(1);
      return null;
    }

    // Check if we have the complete message
    const totalLength = 9 + length;
    if (this.buffer.length < totalLength) {
      return null;
    }

    // Extract the JSON content
    const jsonBuffer = this.buffer.slice(9, totalLength);
    this.buffer = this.buffer.slice(totalLength);

    try {
      const data = JSON.parse(jsonBuffer.toString('utf8'));
      return { type: typeCode, data };
    } catch (e) {
      console.error('[FRP Protocol] JSON parse error:', e.message);
      console.error('[FRP Protocol] Raw data:', jsonBuffer.toString('utf8'));
      return null;
    }
  }

  /**
   * Find the next valid FRP message type in buffer
   * @private
   * @returns {number} Index of next valid type, or -1 if not found
   */
  _findNextValidType() {
    const validTypes = Object.values(MsgType);
    for (let i = 1; i < this.buffer.length; i++) {
      if (validTypes.includes(this.buffer[i])) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Clear the buffer
   */
  clear() {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Write a message to a stream
 *
 * Wire format:
 * - 1 byte: type code
 * - 8 bytes: length (int64, big-endian)
 * - N bytes: JSON content
 *
 * @param {net.Socket} socket
 * @param {number} type - Message type code
 * @param {object} data - Message data
 */
export function writeMessage(socket, type, data) {
  const json = JSON.stringify(data);
  const jsonBuffer = Buffer.from(json, 'utf8');

  // Create message: 1 byte type + 8 bytes length + JSON
  const message = Buffer.alloc(1 + 8 + jsonBuffer.length);
  message[0] = type;
  message.writeBigInt64BE(BigInt(jsonBuffer.length), 1);
  jsonBuffer.copy(message, 9);

  socket.write(message);
}

/**
 * Create a Login message
 * @param {object} options
 * @returns {object}
 */
export function createLoginMessage(options) {
  const timestamp = Math.floor(Date.now() / 1000);
  const token = options.token || '';
  return {
    version: options.version || '0.65.0',  // Match server version
    hostname: os.hostname(),
    os: process.platform === 'win32' ? 'windows' : process.platform,
    arch: process.arch === 'x64' ? 'amd64' : process.arch,
    user: options.user || '',
    privilege_key: getAuthKey(token, timestamp),
    timestamp: timestamp,
    run_id: options.runId || '',
    metas: options.metas || {},
    pool_count: options.poolCount !== undefined ? options.poolCount : 1,
  };
}

/**
 * Create a NewProxy message for HTTP proxy
 * @param {object} options
 * @returns {object}
 */
export function createNewProxyMessage(options) {
  const msg = {
    proxy_name: options.proxyName,
    proxy_type: options.proxyType || 'http',
    use_encryption: options.useEncryption || false,
    use_compression: options.useCompression || false,
  };

  // HTTP/HTTPS specific fields
  if (options.proxyType === 'http' || options.proxyType === 'https' || !options.proxyType) {
    if (options.customDomains) {
      msg.custom_domains = options.customDomains;
    }
    if (options.subdomain) {
      msg.subdomain = options.subdomain;
    }
    if (options.locations) {
      msg.locations = options.locations;
    }
    if (options.httpUser) {
      msg.http_user = options.httpUser;
    }
    if (options.httpPwd) {
      msg.http_pwd = options.httpPwd;
    }
    if (options.hostHeaderRewrite) {
      msg.host_header_rewrite = options.hostHeaderRewrite;
    }
    if (options.headers) {
      msg.headers = options.headers;
    }
  }

  // TCP/UDP specific fields
  if (options.proxyType === 'tcp' || options.proxyType === 'udp') {
    if (options.remotePort) {
      msg.remote_port = options.remotePort;
    }
  }

  return msg;
}

/**
 * Create a NewWorkConn message
 * @param {object} options
 * @returns {object}
 */
export function createNewWorkConnMessage(options) {
  return {
    run_id: options.runId,
    privilege_key: options.privilegeKey || '',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Create a Ping message
 * @param {object} options
 * @returns {object}
 */
export function createPingMessage(options = {}) {
  return {
    privilege_key: options.privilegeKey || '',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Create a CloseProxy message
 * @param {string} proxyName
 * @returns {object}
 */
export function createCloseProxyMessage(proxyName) {
  return {
    proxy_name: proxyName,
  };
}
