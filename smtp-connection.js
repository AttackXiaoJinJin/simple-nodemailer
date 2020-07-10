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
// smtp连接 实例，注意继承的是 EventEmitter
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
  //创建smtp服务的连接并建立连接
  connect(connectCallback) {
    if (typeof connectCallback === 'function') {
      this.once('connect', () => {
        connectCallback();
      });

    }

    let opts = {
      port: this.port, //465
      host: this.host //smtp.exmail.qq.com
    };

    let setupConnectionHandlers = () => {
      this._connectionTimeout = setTimeout(() => {
        this._onError('Connection timeout', 'ETIMEDOUT', false, 'CONN');
      }, this.options.connectionTimeout || CONNECTION_TIMEOUT);

      this._socket.on('error', this._onSocketError);
    };

    return shared.resolveHostname(opts, (err, resolved) => {
      //执行到这里的时候，dns已经解析完域名了
      if (err) {
        return setImmediate(() => this._onError(err, 'EDNS', false, 'CONN'));
      }
      //resolved:{host:'113.96.232.106',servername:'smtp.exmail.qq.com'} port:465
      Object.keys(resolved).forEach(key => {
        if (key.charAt(0) !== '_' && resolved[key]) {
          opts[key] = resolved[key];
        }
      });
      try {
        //tls.connect与https.connect的区别：默认情况下不启用SNI（服务器名称指示）扩展名，这可能导致某些服务器返回不正确的证书或完全拒绝连接
        //http://nodejs.cn/api/tls.html#tls_tls_connect_options_callback
        //建立tls连接
        // opts={host:'113.96.232.106', port:465,servername:'smtp.exmail.qq.com'}
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
    this._closing = true;

    let closeMethod = 'end';
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
  //位置：smtp-connection.js
  //验证用户
  login(authData, callback) {
    this._auth = authData || {};
    // Select SASL authentication method
    //_responseActions的执行时机是等到server连接成功，并发送data后，再执行的
    this._responseActions.push(str => {
      this._actionAUTHComplete(str, callback);
    });
    //将用户名、密码转为base64并拼接
    this._sendCommand(
      'AUTH PLAIN ' +
      Buffer.from(
        //this._auth.user+'\u0000'+
        //\u0000 表示空格也就是 空格+用户名+空格+密码
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
  //位置：smtp-connection.js
  send(envelope, message, done) {
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
      //这个callback是发送RCPT TO请求后，发送DATA请求时，执行的callback
      if (err) {
        return callback(err);
      }
      let envelopeTime = Date.now();
      //创建发送流
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
        //将发送流导入 可读流ReadStream中
        message.pipe(stream);
    });
  }

  /**
   * Connection listener that is run when the connection to
   * the server is opened
   *
   * @event
   */
  //当建立与服务器的连接时，运行监听器listener
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
    //打开socket的 data listener
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
    //因为上面打开了data listener，这里就防止_socket休眠
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
    //接收到server的response的情况
    //1.建立tls连接成功时 220 smtp.qq.com Esmtp QQ Mail Server
    //2.发送gretting问候请求时 250-smtp.qq.com 250-PIPELINING 250-SIZE 73400320 250-AUTH LOGIN PLAIN 250-AUTH=LOGIN 250-MAILCOMPRESS 250 8BITMIME
    //3.发送auth登录验证时 235 Authentication successful
    //4.发送发件人MAIL FROM时 250 Ok
    //5.发送收件人列表RCPT TO时 250 Ok
    //6.发送"DATA" 时 354 End data with <CR><LF>.<CR><LF>
    //7.发送邮件content时 250 Ok: queued as
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
  //不看
  _formatError(message, type, response, command) {
    // let err;
    //
    // if (/Error\]$/i.test(Object.prototype.toString.call(message))) {
    //   err = message;
    // } else {
    //   err = new Error(message);
    // }
    //
    // if (type && type !== 'Error') {
    //   err.code = type;
    // }
    //
    // if (response) {
    //   err.response = response;
    //   err.message += ': ' + response;
    // }
    //
    // let responseCode = (typeof response === 'string' && Number((response.match(/^\d+/) || [])[0])) || false;
    // if (responseCode) {
    //   err.responseCode = responseCode;
    // }
    //
    // if (command) {
    //   err.command = command;
    // }

    // return err;
    return 'error454'
  }

  /**
   * 'close' listener for the socket
   *
   * @event
   */
  _onClose() {
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
  //位置：smtp-connection.js
  _sendCommand(str) {
    if (this._destroyed) {
      // Connection already closed, can't send any more data
      return;
    }

    if (this._socket.destroyed) {
      return this.close();
    }
    //str:DATA
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
  //位置：smtp-connection.js
  //创建新的message，从 MAIL FROM开始
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
    return args.length ? ' ' + args.join(' ') : '';
  }
  //位置：smtp-connection.js
  //创建发送流
  _createSendStream(callback) {
    let dataStream = new DataStream();
    let logStream;

    this._responseActions.push(str => {
      this._actionSMTPStream(str, callback);
    });
    //将TLSSocket写入流，以便边读边写
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
  //位置：smtp-connection.js
  _actionGreeting(str) {
    clearTimeout(this._greetingTimeout);

    this._responseActions.push(this._actionEHLO);
    this._sendCommand('EHLO ' + this.name);
  }

  /**
   * Handles server response for EHLO command. If it yielded in
   * error, try HELO instead, otherwise initiate TLS negotiation
   * if STARTTLS is supported by the server or move into the
   * authentication phase.
   *
   * @param {String} str Message from the server
   */
  //位置：smtp-connection.js
  //当socket.write发送了问候请求后
  //判断server回复的内容里对登录方式的支持
  _actionEHLO(str) {
    let match;

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

    // Detect if the server supports SIZE extensions (and the max allowed size)
    if ((match = str.match(/[ -]SIZE(?:[ \t]+(\d+))?/im))) {
      this._supportedExtensions.push('SIZE');
      this._maxAllowedSize = Number(match[1]) || 0;
    }

    this.emit('connect');
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
  //发送MAIL FROM请求，判断邮件的发起者是否正常
  _actionMAIL(str, callback) { //250 Ok
    let message, curRecipient;
    this._recipientQueue = [];

    while (this._envelope.rcptQueue.length) {
      curRecipient = this._envelope.rcptQueue.shift();
      this._recipientQueue.push(curRecipient);
      this._responseActions.push(str => {
        this._actionRCPT(str, callback);
      });
      this._sendCommand('RCPT TO:<' + curRecipient + '>' + this._getDsnRcptToArgs()); //'RCPT TO:<邮件接收者>'
    }
  }

  /**
   * Handle response for a RCPT TO: command
   *
   * @param {String} str Message from the server
   */
  //位置：smtp-connection.js
  //发送RCPT TO请求成功后，发起DATA请求
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
    //执行的是this._setEnvelope的callback
    callback(null, response);
  }

  /**
   * Handle response for a DATA stream when using SMTP
   * We expect a single response that defines if the sending succeeded or failed
   *
   * @param {String} str Message from the server
   */
  //发送邮件后的callback
  _actionSMTPStream(str, callback) {
      // Message sent succesfully
      return callback(null, str); //this._createSendStream的callback
  }

  _getHostname() {
    // defaul hostname is machine hostname or [IP]
    // let defaultHostname = os.hostname() || '';
    // return defaultHostname;
    return os.hostname()
  }
}

module.exports = SMTPConnection;
