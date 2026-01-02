/**
 * Native FRP Client Implementation with Yamux
 *
 * A pure Node.js implementation of frpc (FRP client).
 * Replaces the external frpc binary to avoid Windows Defender blocking.
 *
 * Connection flow:
 * 1. TCP connect to server
 * 2. Send 0x17 byte (FRP TLS head byte) if TLS enabled
 * 3. TLS handshake if TLS enabled
 * 4. Establish yamux session (TCP Mux)
 * 5. Open yamux stream for control channel
 * 6. Send FRP protocol messages on control stream
 *
 * Translated from: github.com/fatedier/frp/client
 */

import net from 'net';
import tls from 'tls';
import { EventEmitter } from 'events';
import { Client as YamuxClient } from 'yamux-js';
import {
  MsgType,
  MsgTypeName,
  MessageReader,
  writeMessage,
  createLoginMessage,
  createNewProxyMessage,
  createNewWorkConnMessage,
  createPingMessage,
  createCloseProxyMessage,
  getAuthKey,
} from './protocol.js';
import { deriveKey, CryptoWriter, CryptoReader } from './crypto.js';

// FRP custom TLS head byte (from frp source: pkg/util/net/tls.go)
const FRP_TLS_HEAD_BYTE = 0x17;

/**
 * NativeFrpClient - Pure Node.js FRP client with Yamux support
 *
 * Events:
 * - 'connected' - Connected to frps server
 * - 'login' - Login successful, receives { runId }
 * - 'proxy' - Proxy registered, receives { proxyName, remoteAddr }
 * - 'error' - Error occurred, receives Error object
 * - 'close' - Connection closed
 * - 'heartbeat' - Heartbeat received
 */
class NativeFrpClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.serverAddr - FRP server address
   * @param {number} options.serverPort - FRP server port (default: 7000)
   * @param {string} options.token - Authentication token
   * @param {boolean} options.useTls - Use TLS connection (default: false)
   * @param {string} options.user - User name (optional)
   * @param {number} options.poolCount - Work connection pool count (default: 1)
   * @param {number} options.heartbeatInterval - Heartbeat interval in seconds (default: 30)
   * @param {number} options.heartbeatTimeout - Heartbeat timeout in seconds (default: 90)
   * @param {string} options.localAddr - Local service address (default: '127.0.0.1')
   * @param {number} options.localPort - Local service port
   */
  constructor(options) {
    super();

    this.serverAddr = options.serverAddr;
    this.serverPort = options.serverPort || 7000;
    this.token = options.token || '';
    this.useTls = options.useTls || false;
    this.user = options.user || '';
    this.poolCount = options.poolCount || 1;
    this.heartbeatInterval = (options.heartbeatInterval || 30) * 1000;
    this.heartbeatTimeout = (options.heartbeatTimeout || 90) * 1000;
    this.localAddr = options.localAddr || '127.0.0.1';
    this.localPort = options.localPort;

    // State
    this.runId = '';
    this.tcpConn = null;        // Underlying TCP connection
    this.tlsConn = null;        // TLS connection (if useTls)
    this.yamuxSession = null;   // Yamux session
    this.controlStream = null;  // Control stream (yamux stream)
    this.messageReader = new MessageReader();
    this.proxies = new Map();   // proxyName -> { remoteAddr, status }
    this.workConns = new Set(); // Active work connections
    this.heartbeatTimer = null;
    this.lastPong = Date.now();
    this.closed = false;
    this.reconnecting = false;

    // Encryption state (FRP encrypts control connection after Login)
    this.encryptionKey = deriveKey(this.token);
    this.cryptoWriter = null;   // Initialized after Login
    this.cryptoReader = null;   // Initialized after Login
    this.encryptionEnabled = false;

    // Bind methods
    this._onControlData = this._onControlData.bind(this);
    this._onControlClose = this._onControlClose.bind(this);
    this._onControlError = this._onControlError.bind(this);
  }

  /**
   * Connect to FRP server
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.yamuxSession) {
      throw new Error('Already connected');
    }

    this.closed = false;

    try {
      // Step 1: Create TCP connection
      console.log(`[NativeFrpClient] Connecting to ${this.serverAddr}:${this.serverPort}...`);
      this.tcpConn = await this._createTcpConnection();
      console.log('[NativeFrpClient] TCP connected');

      let conn = this.tcpConn;

      // Step 2 & 3: TLS upgrade if needed
      if (this.useTls) {
        conn = await this._upgradeTls(this.tcpConn);
        console.log('[NativeFrpClient] TLS handshake complete');
      }

      // Step 4: Establish yamux session
      console.log('[NativeFrpClient] Establishing yamux session...');
      this.yamuxSession = new YamuxClient({
        onStream: (stream) => {
          // Server-initiated streams (not expected in normal operation)
          console.log('[NativeFrpClient] Received server-initiated stream');
          stream.on('error', (err) => {
            console.error('[NativeFrpClient] Server stream error:', err.message);
          });
        },
      });

      // Pipe connection through yamux
      conn.pipe(this.yamuxSession).pipe(conn);

      // Handle yamux errors
      this.yamuxSession.on('error', (err) => {
        console.error('[NativeFrpClient] Yamux session error:', err.message);
        this.emit('error', err);
        this.close();
      });

      // Wait for yamux to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Step 5: Open control stream
      console.log('[NativeFrpClient] Opening control stream...');
      this.controlStream = this.yamuxSession.open();

      this.controlStream.on('data', this._onControlData);
      this.controlStream.on('close', this._onControlClose);
      this.controlStream.on('end', this._onControlClose);
      this.controlStream.on('error', this._onControlError);

      // Step 6: Send login message
      await this._sendLogin();

    } catch (err) {
      console.error('[NativeFrpClient] Connection failed:', err.message);
      this.close();
      throw err;
    }
  }

  /**
   * Create TCP connection
   * @private
   * @returns {Promise<net.Socket>}
   */
  _createTcpConnection() {
    return new Promise((resolve, reject) => {
      const conn = net.connect({
        host: this.serverAddr,
        port: this.serverPort,
      });

      const timeout = setTimeout(() => {
        conn.destroy();
        reject(new Error('TCP connection timeout'));
      }, 10000);

      conn.on('connect', () => {
        clearTimeout(timeout);
        resolve(conn);
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Upgrade TCP connection to TLS
   * Sends FRP TLS head byte (0x17) first
   * @private
   * @param {net.Socket} tcpConn
   * @returns {Promise<tls.TLSSocket>}
   */
  _upgradeTls(tcpConn) {
    return new Promise((resolve, reject) => {
      // Send FRP TLS head byte first
      console.log('[NativeFrpClient] Sending FRP TLS head byte (0x17)...');
      tcpConn.write(Buffer.from([FRP_TLS_HEAD_BYTE]));

      // Upgrade to TLS
      console.log('[NativeFrpClient] Upgrading to TLS...');
      const tlsConn = tls.connect({
        socket: tcpConn,
        rejectUnauthorized: false, // Allow self-signed certs
      }, () => {
        this.tlsConn = tlsConn;
        resolve(tlsConn);
      });

      tlsConn.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Send login message and wait for response
   * @private
   * @returns {Promise<void>}
   */
  _sendLogin() {
    return new Promise((resolve, reject) => {
      // Create login message
      const loginMsg = createLoginMessage({
        token: this.token,
        user: this.user,
        runId: this.runId,
        poolCount: this.poolCount,
      });

      console.log('[NativeFrpClient] Sending login message...');
      writeMessage(this.controlStream, MsgType.Login, loginMsg);

      // Store resolve/reject for login response handler
      this._loginResolve = resolve;
      this._loginReject = reject;

      // Login timeout
      this._loginTimeout = setTimeout(() => {
        this._loginReject = null;
        this._loginResolve = null;
        reject(new Error('Login timeout'));
        this.close();
      }, 10000);
    });
  }

  /**
   * Handle incoming data on control stream
   * @private
   */
  _onControlData(data) {
    console.log(`[NativeFrpClient] Received raw data: ${data.length} bytes, encryption: ${this.encryptionEnabled}`);

    // Decrypt data if encryption is enabled
    if (this.encryptionEnabled && this.cryptoReader) {
      console.log(`[NativeFrpClient] Decrypting data...`);
      data = this.cryptoReader.read(data);
      console.log(`[NativeFrpClient] Decrypted data: ${data.length} bytes`);
      if (data.length === 0) {
        // Still collecting IV, wait for more data
        console.log(`[NativeFrpClient] Still collecting IV, waiting for more data`);
        return;
      }
      console.log(`[NativeFrpClient] Decrypted first bytes: ${data.slice(0, Math.min(20, data.length)).toString('hex')}`);
    }

    this.messageReader.append(data);

    let msg;
    while ((msg = this.messageReader.read()) !== null) {
      this._handleMessage(msg);
    }
  }

  /**
   * Handle a complete message
   * @private
   */
  _handleMessage(msg) {
    const typeName = MsgTypeName[msg.type] || `Unknown(0x${msg.type.toString(16)})`;
    console.log(`[NativeFrpClient] Received: ${typeName}`, JSON.stringify(msg.data).substring(0, 200));

    switch (msg.type) {
      case MsgType.LoginResp:
        this._handleLoginResp(msg.data);
        break;

      case MsgType.NewProxyResp:
        this._handleNewProxyResp(msg.data);
        break;

      case MsgType.Pong:
        this._handlePong(msg.data);
        break;

      case MsgType.ReqWorkConn:
        this._handleReqWorkConn(msg.data);
        break;

      default:
        console.log(`[NativeFrpClient] Unhandled message type: ${typeName}`);
    }
  }

  /**
   * Handle login response
   * @private
   */
  _handleLoginResp(data) {
    clearTimeout(this._loginTimeout);

    if (data.error) {
      console.error('[NativeFrpClient] Login failed:', data.error);
      if (this._loginReject) {
        this._loginReject(new Error(data.error));
        this._loginReject = null;
        this._loginResolve = null;
      }
      this.emit('error', new Error(`Login failed: ${data.error}`));
      this.close();
      return;
    }

    this.runId = data.run_id;
    console.log(`[NativeFrpClient] Login successful, runId: ${this.runId}`);

    // Enable encryption after successful login
    // FRP encrypts all messages after LoginResp
    console.log('[NativeFrpClient] Enabling encryption on control connection...');
    this.cryptoWriter = new CryptoWriter(this.encryptionKey);
    this.cryptoReader = new CryptoReader(this.encryptionKey);
    this.encryptionEnabled = true;

    // Start heartbeat
    this._startHeartbeat();

    this.emit('connected');
    this.emit('login', { runId: this.runId });

    if (this._loginResolve) {
      this._loginResolve();
      this._loginResolve = null;
      this._loginReject = null;
    }
  }

  /**
   * Handle new proxy response
   * @private
   */
  _handleNewProxyResp(data) {
    const proxyName = data.proxy_name;

    if (data.error) {
      console.error(`[NativeFrpClient] Proxy [${proxyName}] registration failed:`, data.error);
      this.proxies.set(proxyName, { status: 'error', error: data.error });
      this.emit('error', new Error(`Proxy [${proxyName}] failed: ${data.error}`));
      return;
    }

    const remoteAddr = data.remote_addr;
    console.log(`[NativeFrpClient] Proxy [${proxyName}] registered at: ${remoteAddr}`);
    this.proxies.set(proxyName, { status: 'running', remoteAddr });
    this.emit('proxy', { proxyName, remoteAddr });
  }

  /**
   * Handle pong message
   * @private
   */
  _handlePong(data) {
    if (data.error) {
      console.error('[NativeFrpClient] Pong error:', data.error);
      this.emit('error', new Error(`Heartbeat error: ${data.error}`));
      this.close();
      return;
    }

    this.lastPong = Date.now();
    this.emit('heartbeat');
  }

  /**
   * Handle request for work connection
   * Server sends this when it needs a new connection to forward traffic
   * @private
   */
  _handleReqWorkConn(data) {
    console.log('[NativeFrpClient] Server requested work connection');
    this._createWorkConnection();
  }

  /**
   * Create a new work connection using yamux stream
   * @private
   */
  async _createWorkConnection() {
    if (!this.yamuxSession || this.closed) {
      console.error('[NativeFrpClient] Cannot create work connection: not connected');
      return;
    }

    try {
      // Open a new yamux stream for work connection
      const workStream = this.yamuxSession.open();

      workStream.on('error', (err) => {
        console.error('[NativeFrpClient] Work stream error:', err.message);
        this.workConns.delete(workStream);
      });

      this.workConns.add(workStream);

      // Send NewWorkConn message
      const timestamp = Math.floor(Date.now() / 1000);
      const msg = createNewWorkConnMessage({
        runId: this.runId,
        privilegeKey: getAuthKey(this.token, timestamp),
        timestamp: timestamp,
      });

      console.log('[NativeFrpClient] Sending NewWorkConn on yamux stream...');
      writeMessage(workStream, MsgType.NewWorkConn, msg);

      // Wait for StartWorkConn response
      const reader = new MessageReader();

      workStream.once('data', (data) => {
        reader.append(data);
        const response = reader.read();

        if (!response || response.type !== MsgType.StartWorkConn) {
          console.error('[NativeFrpClient] Unexpected response on work connection');
          workStream.destroy();
          this.workConns.delete(workStream);
          return;
        }

        const startMsg = response.data;
        if (startMsg.error) {
          console.error('[NativeFrpClient] StartWorkConn error:', startMsg.error);
          workStream.destroy();
          this.workConns.delete(workStream);
          return;
        }

        console.log(`[NativeFrpClient] StartWorkConn for proxy: ${startMsg.proxy_name}`);
        this._handleWorkConnection(workStream, startMsg, reader);
      });

      workStream.on('close', () => {
        this.workConns.delete(workStream);
      });

    } catch (err) {
      console.error('[NativeFrpClient] Failed to create work connection:', err.message);
    }
  }

  /**
   * Handle an established work connection - forward traffic to local service
   * @private
   */
  _handleWorkConnection(workStream, startMsg, reader) {
    const proxyName = startMsg.proxy_name;
    const proxy = this.proxies.get(proxyName);

    if (!proxy) {
      console.error(`[NativeFrpClient] Unknown proxy: ${proxyName}`);
      workStream.destroy();
      return;
    }

    // Connect to local service
    const localConn = net.connect({
      host: this.localAddr,
      port: this.localPort,
    });

    localConn.on('connect', () => {
      console.log(`[NativeFrpClient] Connected to local service ${this.localAddr}:${this.localPort}`);

      // Forward any remaining data in the reader buffer
      if (reader.buffer.length > 0) {
        localConn.write(reader.buffer);
        reader.clear();
      }

      // Bidirectional pipe
      workStream.pipe(localConn);
      localConn.pipe(workStream);
    });

    localConn.on('error', (err) => {
      console.error(`[NativeFrpClient] Local connection error: ${err.message}`);
      workStream.destroy();
    });

    localConn.on('close', () => {
      workStream.destroy();
    });

    workStream.on('close', () => {
      localConn.destroy();
    });
  }

  /**
   * Write a message to control stream (with encryption if enabled)
   * @private
   * @param {number} type - Message type code
   * @param {object} data - Message data
   */
  _writeMessage(type, data) {
    const json = JSON.stringify(data);
    const jsonBuffer = Buffer.from(json, 'utf8');

    // Create message: 1 byte type + 8 bytes length + JSON
    const message = Buffer.alloc(1 + 8 + jsonBuffer.length);
    message[0] = type;
    message.writeBigInt64BE(BigInt(jsonBuffer.length), 1);
    jsonBuffer.copy(message, 9);

    if (this.encryptionEnabled && this.cryptoWriter) {
      // Encrypt the message
      console.log(`[NativeFrpClient] Encrypting message type 0x${type.toString(16)}, length ${message.length}`);
      const encrypted = this.cryptoWriter.write(message);
      console.log(`[NativeFrpClient] Encrypted length: ${encrypted.length}`);
      this.controlStream.write(encrypted);
    } else {
      // Send plaintext (only for Login message)
      this.controlStream.write(message);
    }
  }

  /**
   * Start heartbeat timer
   * @private
   */
  _startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.lastPong = Date.now();

    this.heartbeatTimer = setInterval(() => {
      // Check timeout
      if (Date.now() - this.lastPong > this.heartbeatTimeout) {
        console.error('[NativeFrpClient] Heartbeat timeout');
        this.emit('error', new Error('Heartbeat timeout'));
        this.close();
        return;
      }

      // Send ping
      if (this.controlStream && !this.closed) {
        const timestamp = Math.floor(Date.now() / 1000);
        const pingMsg = createPingMessage({
          privilegeKey: getAuthKey(this.token, timestamp),
          timestamp: timestamp,
        });
        this._writeMessage(MsgType.Ping, pingMsg);
      }
    }, this.heartbeatInterval);
  }

  /**
   * Register an HTTP proxy
   * @param {object} options
   * @param {string} options.proxyName - Unique proxy name
   * @param {string} options.subdomain - Subdomain for HTTP proxy
   * @param {string[]} options.customDomains - Custom domains (optional)
   * @returns {Promise<{ remoteAddr: string }>}
   */
  async registerHttpProxy(options) {
    if (!this.controlStream || this.closed) {
      throw new Error('Not connected');
    }

    const proxyName = options.proxyName;
    const msg = createNewProxyMessage({
      proxyName,
      proxyType: 'http',
      subdomain: options.subdomain,
      customDomains: options.customDomains,
      useEncryption: options.useEncryption || false,
      useCompression: options.useCompression || false,
    });

    console.log(`[NativeFrpClient] Registering HTTP proxy: ${proxyName}`);
    this._writeMessage(MsgType.NewProxy, msg);

    // Wait for response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Proxy registration timeout'));
      }, 10000);

      const checkProxy = () => {
        const proxy = this.proxies.get(proxyName);
        if (proxy) {
          clearTimeout(timeout);
          if (proxy.status === 'error') {
            reject(new Error(proxy.error));
          } else {
            resolve({ remoteAddr: proxy.remoteAddr });
          }
        } else {
          setTimeout(checkProxy, 100);
        }
      };
      checkProxy();
    });
  }

  /**
   * Close a proxy
   * @param {string} proxyName
   */
  closeProxy(proxyName) {
    if (!this.controlStream || this.closed) {
      return;
    }

    const msg = createCloseProxyMessage(proxyName);
    this._writeMessage(MsgType.CloseProxy, msg);
    this.proxies.delete(proxyName);
    console.log(`[NativeFrpClient] Closed proxy: ${proxyName}`);
  }

  /**
   * Handle control stream close
   * @private
   */
  _onControlClose() {
    console.log('[NativeFrpClient] Control stream closed');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.controlStream = null;
    this.messageReader.clear();

    if (!this.closed) {
      this.emit('close');
    }
  }

  /**
   * Handle control stream error
   * @private
   */
  _onControlError(err) {
    console.error('[NativeFrpClient] Control stream error:', err.message);
    this.emit('error', err);
  }

  /**
   * Close the client
   */
  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    console.log('[NativeFrpClient] Closing...');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all work connections
    for (const conn of this.workConns) {
      conn.destroy();
    }
    this.workConns.clear();

    // Close control stream
    if (this.controlStream) {
      this.controlStream.destroy();
      this.controlStream = null;
    }

    // Close yamux session
    if (this.yamuxSession) {
      this.yamuxSession.destroy();
      this.yamuxSession = null;
    }

    // Close TLS connection
    if (this.tlsConn) {
      this.tlsConn.destroy();
      this.tlsConn = null;
    }

    // Close TCP connection
    if (this.tcpConn) {
      this.tcpConn.destroy();
      this.tcpConn = null;
    }

    this.proxies.clear();
    this.messageReader.clear();
  }

  /**
   * Get proxy status
   * @param {string} proxyName
   * @returns {{ status: string, remoteAddr?: string, error?: string } | null}
   */
  getProxyStatus(proxyName) {
    return this.proxies.get(proxyName) || null;
  }

  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnected() {
    return this.yamuxSession !== null && !this.closed;
  }
}

export default NativeFrpClient;
