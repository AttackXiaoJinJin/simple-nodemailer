const EventEmitter = require('events').EventEmitter;
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const DataStream = require('./data-stream');
const PassThrough = require('stream').PassThrough;
const shared = require('./shared');

// default timeout values in ms
const CONNECTION_TIMEOUT = 2 * 60 * 1000; // how much to wait for the connection to be established
const SOCKET_TIMEOUT = 10 * 60 * 1000; // how much to wait for socket inactivity before disconnecting the client
const GREETING_TIMEOUT = 30 * 1000; // how much to wait after connection is established but SMTP greeting is not receieved

/**
 * Generates a SMTP connection object
 *
 * Optional options object takes the following possible properties:
 *
 *  * **port** - is the port to connect to (defaults to 587 or 465)
 *  * **host** - is the hostname or IP address to connect to (defaults to 'localhost')
 *  * **secure** - use SSL
 *  * **ignoreTLS** - ignore server support for STARTTLS
 *  * **requireTLS** - forces the client to use STARTTLS
 *  * **name** - the name of the client server
 *  * **localAddress** - outbound address to bind to (see: http://nodejs.org/api/net.html#net_net_connect_options_connectionlistener)
 *  * **greetingTimeout** - Time to wait in ms until greeting message is received from the server (defaults to 10000)
 *  * **connectionTimeout** - how many milliseconds to wait for the connection to establish
 *  * **socketTimeout** - Time of inactivity until the connection is closed (defaults to 1 hour)
 *  * **lmtp** - if true, uses LMTP instead of SMTP protocol
 *  * **logger** - bunyan compatible logger interface
 *  * **debug** - if true pass SMTP traffic to the logger
 *  * **tls** - options for createCredentials
 *  * **socket** - existing socket to use instead of creating a new one (see: http://nodejs.org/api/net.html#net_class_net_socket)
 *  * **secured** - boolean indicates that the provided socket has already been upgraded to tls
 *
 * @constructor
 * @namespace SMTP Client module
 * @param {Object} [options] Option properties
 */
class SMTPConnection extends EventEmitter {
  constructor(options) {
    super(options);

    this.id = crypto
      .randomBytes(8)
      .toString('base64')
      .replace(/\W/g, '');
    this.stage = 'init';

    this.options = options || {};

    this.secureConnection = !!this.options.secure;
    this.alreadySecured = !!this.options.secured;

    this.port = Number(this.options.port) || (this.secureConnection ? 465 : 587);
    this.host = this.options.host || 'localhost';

    if (typeof this.options.secure === 'undefined' && this.port === 465) {
      // if secure option is not set but port is 465, then default to secure
      this.secureConnection = true;
    }

    this.name = this.options.name || this._getHostname();

    // this.customAuth = new Map();
    // Object.keys(this.options.customAuth || {}).forEach(key => {
    //   let mapKey = (key || '')
    //     .toString()
    //     .trim()
    //     .toUpperCase();
    //   if (!mapKey) {
    //     return;
    //   }
    //   this.customAuth.set(mapKey, this.options.customAuth[key]);
    // });

    /**
     * Expose version nr, just for the reference
     * @type {String}
     */
    // this.version = packageInfo.version;

    /**
     * If true, then the user is authenticated
     * @type {Boolean}
     */
    this.authenticated = false;

    /**
     * If set to true, this instance is no longer active
     * @private
     */
    this.destroyed = false;

    /**
     * Defines if the current connection is secure or not. If not,
     * STARTTLS can be used if available
     * @private
     */
    this.secure = !!this.secureConnection;

    /**
     * Store incomplete messages coming from the server
     * @private
     */
    this._remainder = '';

    /**
     * Unprocessed responses from the server
     * @type {Array}
     */
    this._responseQueue = [];

    this.lastServerResponse = false;

    /**
     * The socket connecting to the server
     * @publick
     */
    this._socket = false;

    /**
     * Lists supported auth mechanisms
     * @private
     */
    this._supportedAuth = [];

    /**
     * Set to true, if EHLO response includes "AUTH".
     * If false then authentication is not tried
     */
    this.allowsAuth = false;

    /**
     * Includes current envelope (from, to)
     * @private
     */
    this._envelope = false;

    /**
     * Lists supported extensions
     * @private
     */
    this._supportedExtensions = [];

    /**
     * Defines the maximum allowed size for a single message
     * @private
     */
    this._maxAllowedSize = 0;

    /**
     * Function queue to run if a data chunk comes from the server
     * @private
     */
    this._responseActions = [];
    this._recipientQueue = [];

    /**
     * Timeout variable for waiting the greeting
     * @private
     */
    this._greetingTimeout = false;

    /**
     * Timeout variable for waiting the connection to start
     * @private
     */
    this._connectionTimeout = false;

    /**
     * If the socket is deemed already closed
     * @private
     */
    this._destroyed = false;

    /**
     * If the socket is already being closed
     * @private
     */
    this._closing = false;

    /**
     * Callbacks for socket's listeners
     */
    this._onSocketData = chunk => this._onData(chunk);
    this._onSocketError = error => this._onError(error, 'ESOCKET', false, 'CONN');
    this._onSocketClose = () => this._onClose();
    this._onSocketEnd = () => this._onEnd();
    this._onSocketTimeout = () => this._onTimeout();
  }

  /**
   * Creates a connection to a SMTP server and sets up connection
   * listener
   */
  connect(connectCallback) {
    if (typeof connectCallback === 'function') {
      this.once('connect', () => {
        connectCallback();
      });

      const isDestroyedMessage = this._isDestroyedMessage('connect');
      if (isDestroyedMessage) {
        return connectCallback(this._formatError(isDestroyedMessage, 'ECONNECTION', false, 'CONN'));
      }
    }

    let opts = {
      port: this.port,
      host: this.host
    };

    if (this.options.localAddress) {
      opts.localAddress = this.options.localAddress;
    }

    let setupConnectionHandlers = () => {
      this._connectionTimeout = setTimeout(() => {
        this._onError('Connection timeout', 'ETIMEDOUT', false, 'CONN');
      }, this.options.connectionTimeout || CONNECTION_TIMEOUT);

      this._socket.on('error', this._onSocketError);
    };

    // connect using tls
    if (this.options.tls) {
      Object.keys(this.options.tls).forEach(key => {
        opts[key] = this.options.tls[key];
      });
    }
    return shared.resolveHostname(opts, (err, resolved) => {
      if (err) {
        return setImmediate(() => this._onError(err, 'EDNS', false, 'CONN'));
      }

      Object.keys(resolved).forEach(key => {
        if (key.charAt(0) !== '_' && resolved[key]) {
          opts[key] = resolved[key];
        }
      });
      try {
        this._socket = tls.connect(opts, () => {
          this._socket.setKeepAlive(true);
          this._onConnect();
        });
        setupConnectionHandlers();
      } catch (E) {
        return setImmediate(() => this._onError(E, 'ECONNECTION', false, 'CONN'));
      }
    });

  }

  /**
   * Closes the connection to the server
   */
  close() {
    clearTimeout(this._connectionTimeout);
    clearTimeout(this._greetingTimeout);
    this._responseActions = [];

    // allow to run this function only once
    if (this._closing) {
      return;
    }
    this._closing = true;

    let closeMethod = 'end';

    if (this.stage === 'init') {
      // Close the socket immediately when connection timed out
      closeMethod = 'destroy';
    }

    let socket = (this._socket && this._socket.socket) || this._socket;

    if (socket && !socket.destroyed) {
      try {
        this._socket[closeMethod]();
      } catch (E) {
        // just ignore
      }
    }

    this._destroy();
  }

  /**
   * Authenticate user
   */
  login(authData, callback) {
    const isDestroyedMessage = this._isDestroyedMessage('login');
    if (isDestroyedMessage) {
      return callback(this._formatError(isDestroyedMessage, 'ECONNECTION', false, 'API'));
    }

    this._auth = authData || {};
    // Select SASL authentication method

    this._authMethod = (this._supportedAuth[0]).toUpperCase().trim();

    this._responseActions.push(str => {
      this._actionAUTHComplete(str, callback);
    });
    this._sendCommand(
      'AUTH PLAIN ' +
      Buffer.from(
        //this._auth.user+'\u0000'+
        '\u0000' + // skip authorization identity as it causes problems with some servers
        this._auth.credentials.user +
        '\u0000' +
        this._auth.credentials.pass,
        'utf-8'
      ).toString('base64')
    );

  }

  /**
   * Sends a message
   *
   * @param {Object} envelope Envelope object, {from: addr, to: [addr]}
   * @param {Object} message String, Buffer or a Stream
   * @param {Function} callback Callback to return once sending is completed
   */
  send(envelope, message, done) {
    if (!message) {
      return done(this._formatError('Empty message', 'EMESSAGE', false, 'API'));
    }

    const isDestroyedMessage = this._isDestroyedMessage('send message');
    if (isDestroyedMessage) {
      return done(this._formatError(isDestroyedMessage, 'ECONNECTION', false, 'API'));
    }

    // reject larger messages than allowed
    if (this._maxAllowedSize && envelope.size > this._maxAllowedSize) {
      return setImmediate(() => {
        done(this._formatError('Message size larger than allowed ' + this._maxAllowedSize, 'EMESSAGE', false, 'MAIL FROM'));
      });
    }

    // ensure that callback is only called once
    let returned = false;
    let callback = function () {
      if (returned) {
        return;
      }
      returned = true;

      done(...arguments);
    };

    if (typeof message.on === 'function') {
      message.on('error', err => callback(this._formatError(err, 'ESTREAM', false, 'API')));
    }

    let startTime = Date.now();
    this._setEnvelope(envelope, (err, info) => {
      if (err) {
        return callback(err);
      }
      let envelopeTime = Date.now();
      let stream = this._createSendStream((err, str) => {
        if (err) {
          return callback(err);
        }

        info.envelopeTime = envelopeTime - startTime;
        info.messageTime = Date.now() - envelopeTime;
        info.messageSize = stream.outByteCount;
        info.response = str;

        return callback(null, info);
      });
      if (typeof message.pipe === 'function') {
        message.pipe(stream);
      } else {
        stream.write(message);
        stream.end();
      }
    });
  }

  /**
   * Connection listener that is run when the connection to
   * the server is opened
   *
   * @event
   */
  _onConnect() {
    clearTimeout(this._connectionTimeout);
    if (this._destroyed) {
      // Connection was established after we already had canceled it
      this.close();
      return;
    }

    this.stage = 'connected';

    // clear existing listeners for the socket
    this._socket.removeListener('data', this._onSocketData);
    this._socket.removeListener('timeout', this._onSocketTimeout);
    this._socket.removeListener('close', this._onSocketClose);
    this._socket.removeListener('end', this._onSocketEnd);

    this._socket.on('data', this._onSocketData);
    this._socket.once('close', this._onSocketClose);
    this._socket.once('end', this._onSocketEnd);

    this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT);
    this._socket.on('timeout', this._onSocketTimeout);

    this._greetingTimeout = setTimeout(() => {
      // if still waiting for greeting, give up
      if (this._socket && !this._destroyed && this._responseActions[0] === this._actionGreeting) {
        this._onError('Greeting never received', 'ETIMEDOUT', false, 'CONN');
      }
    }, this.options.greetingTimeout || GREETING_TIMEOUT);

    this._responseActions.push(this._actionGreeting);

    // we have a 'data' listener set up so resume socket if it was paused
    this._socket.resume();
  }

  /**
   * 'data' listener for data coming from the server
   *
   * @event
   * @param {Buffer} chunk Data chunk coming from the server
   */
  _onData(chunk) {
    if (this._destroyed || !chunk || !chunk.length) {
      return;
    }

    let data = (chunk || '').toString('binary');
    let lines = (this._remainder + data).split(/\r?\n/);
    let lastline;

    this._remainder = lines.pop();

    for (let i = 0, len = lines.length; i < len; i++) {
      if (this._responseQueue.length) {
        lastline = this._responseQueue[this._responseQueue.length - 1];
        if (/^\d+-/.test(lastline.split('\n').pop())) {
          this._responseQueue[this._responseQueue.length - 1] += '\n' + lines[i];
          continue;
        }
      }
      this._responseQueue.push(lines[i]);
    }

    if (this._responseQueue.length) {
      lastline = this._responseQueue[this._responseQueue.length - 1];
      if (/^\d+-/.test(lastline.split('\n').pop())) {
        return;
      }
    }

    this._processResponse();
  }

  /**
   * 'error' listener for the socket
   *
   * @event
   * @param {Error} err Error object
   * @param {String} type Error name
   */
  _onError(err, type, data, command) {
    clearTimeout(this._connectionTimeout);
    clearTimeout(this._greetingTimeout);

    if (this._destroyed) {
      // just ignore, already closed
      // this might happen when a socket is canceled because of reached timeout
      // but the socket timeout error itself receives only after
      return;
    }

    err = this._formatError(err, type, data, command);

    this.emit('error', err);
    this.close();
  }

  _formatError(message, type, response, command) {
    let err;

    if (/Error\]$/i.test(Object.prototype.toString.call(message))) {
      err = message;
    } else {
      err = new Error(message);
    }

    if (type && type !== 'Error') {
      err.code = type;
    }

    if (response) {
      err.response = response;
      err.message += ': ' + response;
    }

    let responseCode = (typeof response === 'string' && Number((response.match(/^\d+/) || [])[0])) || false;
    if (responseCode) {
      err.responseCode = responseCode;
    }

    if (command) {
      err.command = command;
    }

    return err;
  }

  /**
   * 'close' listener for the socket
   *
   * @event
   */
  _onClose() {
    if (this.upgrading && !this._destroyed) {
      return this._onError(new Error('Connection closed unexpectedly'), 'ETLS', false, 'CONN');
    } else if (![this._actionGreeting, this.close].includes(this._responseActions[0]) && !this._destroyed) {
      return this._onError(new Error('Connection closed unexpectedly'), 'ECONNECTION', false, 'CONN');
    }

    this._destroy();
  }

  /**
   * 'end' listener for the socket
   *
   * @event
   */
  _onEnd() {
    if (this._socket && !this._socket.destroyed) {
      this._socket.destroy();
    }
  }

  /**
   * 'timeout' listener for the socket
   *
   * @event
   */
  _onTimeout() {
    return this._onError(new Error('Timeout'), 'ETIMEDOUT', false, 'CONN');
  }

  /**
   * Destroys the client, emits 'end'
   */
  _destroy() {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.emit('end');
  }

  /**
   * Upgrades the connection to TLS
   *
   * @param {Function} callback Callback function to run when the connection
   *        has been secured
   */
  _upgradeConnection(callback) {
    // do not remove all listeners or it breaks node v0.10 as there's
    // apparently a 'finish' event set that would be cleared as well

    // we can safely keep 'error', 'end', 'close' etc. events
    this._socket.removeListener('data', this._onSocketData); // incoming data is going to be gibberish from this point onwards
    this._socket.removeListener('timeout', this._onSocketTimeout); // timeout will be re-set for the new socket object

    let socketPlain = this._socket;
    let opts = {
      socket: this._socket,
      host: this.host
    };

    Object.keys(this.options.tls || {}).forEach(key => {
      opts[key] = this.options.tls[key];
    });

    this.upgrading = true;
    this._socket = tls.connect(opts, () => {
      this.secure = true;
      this.upgrading = false;
      this._socket.on('data', this._onSocketData);

      socketPlain.removeListener('close', this._onSocketClose);
      socketPlain.removeListener('end', this._onSocketEnd);

      return callback(null, true);
    });

    this._socket.on('error', this._onSocketError);
    this._socket.once('close', this._onSocketClose);
    this._socket.once('end', this._onSocketEnd);

    this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT); // 10 min.
    this._socket.on('timeout', this._onSocketTimeout);

    // resume in case the socket was paused
    socketPlain.resume();
  }

  /**
   * Processes queued responses from the server
   *
   * @param {Boolean} force If true, ignores _processing flag
   */
  _processResponse() {
    //不能删，可能为false
    if (!this._responseQueue.length) {
      return false;
    }

    let str = (this.lastServerResponse = (this._responseQueue.shift()).toString());
    let action = this._responseActions.shift();

    action.call(this, str);
    setImmediate(() => this._processResponse(true));
  }

  /**
   * Send a command to the server, append \r\n
   *
   * @param {String} str String to be sent to the server
   */
  _sendCommand(str) {
    if (this._destroyed) {
      // Connection already closed, can't send any more data
      return;
    }

    if (this._socket.destroyed) {
      return this.close();
    }

    this._socket.write(Buffer.from(str + '\r\n', 'utf-8'));
  }

  /**
   * Initiates a new message by submitting envelope data, starting with
   * MAIL FROM: command
   *
   * @param {Object} envelope Envelope object in the form of
   *        {from:'...', to:['...']}
   *        or
   *        {from:{address:'...',name:'...'}, to:[address:'...',name:'...']}
   */
  _setEnvelope(envelope, callback) {
    let args = [];
    let useSmtpUtf8 = false;

    this._envelope = envelope




    // clone the recipients array for latter manipulation
    // this._envelope.rcptQueue = JSON.parse(JSON.stringify(this._envelope.to || []));
    this._envelope.rcptQueue = JSON.parse(JSON.stringify(this._envelope.to));
    this._envelope.rejected = [];
    this._envelope.rejectedErrors = [];
    this._envelope.accepted = [];

    this._responseActions.push(str => {
      this._actionMAIL(str, callback);
    });

    this._sendCommand('MAIL FROM:<' + this._envelope.from + '>' + (args.length ? ' ' + args.join(' ') : ''));
  }

  _getDsnRcptToArgs() {
    let args = [];
    // If the server supports DSN and the envelope includes an DSN prop
    // then append DSN params to the RCPT TO command
    if (this._envelope.dsn && this._supportedExtensions.includes('DSN')) {
      if (this._envelope.dsn.notify) {
        args.push('NOTIFY=' + shared.encodeXText(this._envelope.dsn.notify));
      }
      if (this._envelope.dsn.orcpt) {
        args.push('ORCPT=' + shared.encodeXText(this._envelope.dsn.orcpt));
      }
    }
    return args.length ? ' ' + args.join(' ') : '';
  }

  _createSendStream(callback) {
    let dataStream = new DataStream();
    let logStream;

    this._responseActions.push(str => {
      this._actionSMTPStream(str, callback);
    });

    dataStream.pipe(this._socket, {
      end: false
    });

    if (this.options.debug) {
      logStream = new PassThrough();
      dataStream.pipe(logStream);
    }

    return dataStream;
  }

  /** ACTIONS **/

  /**
   * Will be run after the connection is created and the server sends
   * a greeting. If the incoming message starts with 220 initiate
   * SMTP session by sending EHLO command
   *
   * @param {String} str Message from the server
   */
  _actionGreeting(str) {
    clearTimeout(this._greetingTimeout);

    this._responseActions.push(this._actionEHLO);
    this._sendCommand('EHLO ' + this.name);
  }

  /**
   * Handles server response for LHLO command. If it yielded in
   * error, emit 'error', otherwise treat this as an EHLO response
   *
   * @param {String} str Message from the server
   */
  _actionLHLO(str) {
    if (str.charAt(0) !== '2') {
      this._onError(new Error('Invalid LHLO. response=' + str), 'EPROTOCOL', str, 'LHLO');
      return;
    }

    this._actionEHLO(str);
  }

  /**
   * Handles server response for EHLO command. If it yielded in
   * error, try HELO instead, otherwise initiate TLS negotiation
   * if STARTTLS is supported by the server or move into the
   * authentication phase.
   *
   * @param {String} str Message from the server
   */
  _actionEHLO(str) {
    let match;

    if (str.substr(0, 3) === '421') {
      this._onError(new Error('Server terminates connection. response=' + str), 'ECONNECTION', str, 'EHLO');
      return;
    }

    if (str.charAt(0) !== '2') {
      if (this.options.requireTLS) {
        this._onError(new Error('EHLO failed but HELO does not support required STARTTLS. response=' + str), 'ECONNECTION', str, 'EHLO');
        return;
      }

      // Try HELO instead
      this._responseActions.push(this._actionHELO);
      this._sendCommand('HELO ' + this.name);
      return;
    }

    // Detect if the server supports STARTTLS
    if (!this.secure && !this.options.ignoreTLS && (/[ -]STARTTLS\b/im.test(str) || this.options.requireTLS)) {
      this._sendCommand('STARTTLS');
      this._responseActions.push(this._actionSTARTTLS);
      return;
    }

    // Detect if the server supports SMTPUTF8
    if (/[ -]SMTPUTF8\b/im.test(str)) {
      this._supportedExtensions.push('SMTPUTF8');
    }

    // Detect if the server supports DSN
    if (/[ -]DSN\b/im.test(str)) {
      this._supportedExtensions.push('DSN');
    }

    // Detect if the server supports 8BITMIME
    if (/[ -]8BITMIME\b/im.test(str)) {
      this._supportedExtensions.push('8BITMIME');
    }

    // Detect if the server supports PIPELINING
    if (/[ -]PIPELINING\b/im.test(str)) {
      this._supportedExtensions.push('PIPELINING');
    }

    // Detect if the server supports AUTH
    if (/[ -]AUTH\b/i.test(str)) {
      this.allowsAuth = true;
    }

    // Detect if the server supports PLAIN auth
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(str)) {
      this._supportedAuth.push('PLAIN');
    }

    // Detect if the server supports LOGIN auth
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(str)) {
      this._supportedAuth.push('LOGIN');
    }

    // Detect if the server supports CRAM-MD5 auth
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(str)) {
      this._supportedAuth.push('CRAM-MD5');
    }

    // Detect if the server supports XOAUTH2 auth
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)XOAUTH2/i.test(str)) {
      this._supportedAuth.push('XOAUTH2');
    }

    // Detect if the server supports SIZE extensions (and the max allowed size)
    if ((match = str.match(/[ -]SIZE(?:[ \t]+(\d+))?/im))) {
      this._supportedExtensions.push('SIZE');
      this._maxAllowedSize = Number(match[1]) || 0;
    }

    this.emit('connect');
  }

  /**
   * Handles server response for HELO command. If it yielded in
   * error, emit 'error', otherwise move into the authentication phase.
   *
   * @param {String} str Message from the server
   */
  _actionHELO(str) {
    if (str.charAt(0) !== '2') {
      this._onError(new Error('Invalid HELO. response=' + str), 'EPROTOCOL', str, 'HELO');
      return;
    }

    // assume that authentication is enabled (most probably is not though)
    this.allowsAuth = true;
    this.emit('connect');
  }

  /**
   * Handles server response for STARTTLS command. If there's an error
   * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
   * succeedes restart the EHLO
   *
   * @param {String} str Message from the server
   */
  _actionSTARTTLS(str) {
    if (str.charAt(0) !== '2') {
      if (this.options.opportunisticTLS) {
        return this.emit('connect');
      }
      this._onError(new Error('Error upgrading connection with STARTTLS'), 'ETLS', str, 'STARTTLS');
      return;
    }

    this._upgradeConnection((err, secured) => {
      if (err) {
        this._onError(new Error('Error initiating TLS - ' + (err.message || err)), 'ETLS', false, 'STARTTLS');
        return;
      }

      if (secured) {
        // restart session
        if (this.options.lmtp) {
          this._responseActions.push(this._actionLHLO);
          this._sendCommand('LHLO ' + this.name);
        } else {
          this._responseActions.push(this._actionEHLO);
          this._sendCommand('EHLO ' + this.name);
        }
      } else {
        this.emit('connect');
      }
    });
  }

  /**
   * Handles the response for authentication, if there's no error,
   * the user can be considered logged in. Start waiting for a message to send
   *
   * @param {String} str Message from the server
   */
  _actionAUTHComplete(str, isRetry, callback) {
    callback = isRetry;
    isRetry = false;

    this.authenticated = true;
    callback(null, true);
  }

  /**
   * Handle response for a MAIL FROM: command
   *
   * @param {String} str Message from the server
   */
  _actionMAIL(str, callback) {
    let message, curRecipient;
    this._recipientQueue = [];

    while (this._envelope.rcptQueue.length) {
      curRecipient = this._envelope.rcptQueue.shift();
      this._recipientQueue.push(curRecipient);
      this._responseActions.push(str => {
        this._actionRCPT(str, callback);
      });
      this._sendCommand('RCPT TO:<' + curRecipient + '>' + this._getDsnRcptToArgs());
    }
  }

  /**
   * Handle response for a RCPT TO: command
   *
   * @param {String} str Message from the server
   */
  _actionRCPT(str, callback) {
    let curRecipient = this._recipientQueue.shift(); //邮箱
    this._envelope.accepted.push(curRecipient);
    this._responseActions.push(str => {
      this._actionDATA(str, callback);
    });
    this._sendCommand('DATA');
  }

  /**
   * Handle response for a DATA command
   *
   * @param {String} str Message from the server
   */
  _actionDATA(str, callback) {
    let response = {
      accepted: this._envelope.accepted,
      rejected: this._envelope.rejected
    };

    callback(null, response);
  }

  /**
   * Handle response for a DATA stream when using SMTP
   * We expect a single response that defines if the sending succeeded or failed
   *
   * @param {String} str Message from the server
   */
  _actionSMTPStream(str, callback) {
    if (Number(str.charAt(0)) !== 2) {
      // Message failed
      return callback(this._formatError('Message failed', 'EMESSAGE', str, 'DATA'));
    } else {
      // Message sent succesfully
      return callback(null, str);
    }
  }

  /**
   *
   * @param {string} command
   * @private
   */
  _isDestroyedMessage(command) {
    if (this._destroyed) {
      return 'Cannot ' + command + ' - smtp connection is already destroyed.';
    }

    if (this._socket) {
      if (this._socket.destroyed) {
        return 'Cannot ' + command + ' - smtp connection socket is already destroyed.';
      }

      if (!this._socket.writable) {
        return 'Cannot ' + command + ' - smtp connection socket is already half-closed.';
      }
    }
  }

  _getHostname() {
    // defaul hostname is machine hostname or [IP]
    let defaultHostname = os.hostname() || '';

    // ignore if not FQDN
    if (defaultHostname.indexOf('.') < 0) {
      defaultHostname = '[127.0.0.1]';
    }

    // IP should be enclosed in []
    if (defaultHostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      defaultHostname = '[' + defaultHostname + ']';
    }

    return defaultHostname;
  }
}

module.exports = SMTPConnection;
