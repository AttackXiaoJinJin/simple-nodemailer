const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const punycode = require('punycode');
const PassThrough = require('stream').PassThrough;

const mimeFuncs = require('./mime-funcs');
const qp = require('./qp');
const base64 = require('./base64');
const addressparser = require('./addressparser');
const fetch = require('./fetch');
const LastNewline = require('./last-newline');

/**
 * Creates a new mime tree node. Assumes 'multipart/*' as the content type
 * if it is a branch, anything else counts as leaf. If rootNode is missing from
 * the options, assumes this is the root.
 *
 * @param {String} contentType Define the content type for the node. Can be left blank for attachments (derived from filename)
 * @param {Object} [options] optional options
 * @param {Object} [options.rootNode] root node for this tree
 * @param {Object} [options.parentNode] immediate parent for this node
 * @param {Object} [options.filename] filename for an attachment node
 * @param {String} [options.baseBoundary] shared part of the unique multipart boundary
 * @param {Boolean} [options.keepBcc] If true, do not exclude Bcc from the generated headers
 * @param {Function} [options.normalizeHeaderKey] method to normalize header keys for custom caseing
 * @param {String} [options.textEncoding] either 'Q' (the default) or 'B'
 */
class MimeNode {
  constructor(contentType, options) {
    this.nodeCounter = 0;

    options = options || {};

    /**
     * shared part of the unique multipart boundary
     */
    this.baseBoundary = options.baseBoundary || crypto.randomBytes(8).toString('hex');
    this.boundaryPrefix = options.boundaryPrefix || '--_NmP';

    this.disableFileAccess = !!options.disableFileAccess;
    this.disableUrlAccess = !!options.disableUrlAccess;

    this.normalizeHeaderKey = options.normalizeHeaderKey;

    /**
     * If date headers is missing and current node is the root, this value is used instead
     */
    this.date = new Date();

    /**
     * Root node for current mime tree
     */
    this.rootNode = options.rootNode || this;

    /**
     * If true include Bcc in generated headers (if available)
     */
    this.keepBcc = !!options.keepBcc;

    /**
     * If filename is specified but contentType is not (probably an attachment)
     * detect the content type from filename extension
     */
    if (options.filename) {
      /**
       * Filename for this node. Useful with attachments
       */
      this.filename = options.filename;
      if (!contentType) {
        contentType = mimeFuncs.detectMimeType(this.filename.split('.').pop());
      }
    }

    /**
     * Indicates which encoding should be used for header strings: "Q" or "B"
     */
    this.textEncoding = (options.textEncoding || '').toString().trim().charAt(0).toUpperCase();

    /**
     * Immediate parent for this node (or undefined if not set)
     */
    this.parentNode = options.parentNode;

    /**
     * Hostname for default message-id values
     */
    this.hostname = options.hostname;

    /**
     * An array for possible child nodes
     */
    this.childNodes = [];

    /**
     * Used for generating unique boundaries (prepended to the shared base)
     */
    this._nodeId = ++this.rootNode.nodeCounter;

    /**
     * A list of header values for this node in the form of [{key:'', value:''}]
     */
    this._headers = [];

    /**
     * True if the content only uses ASCII printable characters
     * @type {Boolean}
     */
    this._isPlainText = false;

    /**
     * True if the content is plain text but has longer lines than allowed
     * @type {Boolean}
     */
    this._hasLongLines = false;

    /**
     * If set, use instead this value for envelopes instead of generating one
     * @type {Boolean}
     */
    this._envelope = false;

    /**
     * If set then use this value as the stream content instead of building it
     * @type {String|Buffer|Stream}
     */
    this._raw = false;

    /**
     * Additional transform streams that the message will be piped before
     * exposing by createReadStream
     * @type {Array}
     */
    this._transforms = [];

    /**
     * Additional process functions that the message will be piped through before
     * exposing by createReadStream. These functions are run after transforms
     * @type {Array}
     */
    this._processFuncs = [];

    /**
     * If content type is set (or derived from the filename) add it to headers
     */
    if (contentType) {
      this.setHeader('Content-Type', contentType);
    }
  }

  /////// PUBLIC METHODS

  /**
   * Creates and appends a child node.Arguments provided are passed to MimeNode constructor
   *
   * @param {String} [contentType] Optional content type
   * @param {Object} [options] Optional options object
   * @return {Object} Created node object
   */
  createChild(contentType, options) {
    if (!options && typeof contentType === 'object') {
      options = contentType;
      contentType = undefined;
    }
    let node = new MimeNode(contentType, options);
    this.appendChild(node);
    return node;
  }

  /**
   * Appends an existing node to the mime tree. Removes the node from an existing
   * tree if needed
   *
   * @param {Object} childNode node to be appended
   * @return {Object} Appended node object
   */
  appendChild(childNode) {
    if (childNode.rootNode !== this.rootNode) {
      childNode.rootNode = this.rootNode;
      childNode._nodeId = ++this.rootNode.nodeCounter;
    }

    childNode.parentNode = this;

    this.childNodes.push(childNode);
    return childNode;
  }

  /**
   * Replaces current node with another node
   *
   * @param {Object} node Replacement node
   * @return {Object} Replacement node
   */
  replace(node) {
    if (node === this) {
      return this;
    }

    this.parentNode.childNodes.forEach((childNode, i) => {
      if (childNode === this) {
        node.rootNode = this.rootNode;
        node.parentNode = this.parentNode;
        node._nodeId = this._nodeId;

        this.rootNode = this;
        this.parentNode = undefined;

        node.parentNode.childNodes[i] = node;
      }
    });

    return node;
  }

  /**
   * Sets a header value. If the value for selected key exists, it is overwritten.
   * You can set multiple values as well by using [{key:'', value:''}] or
   * {key: 'value'} as the first argument.
   *
   * @param {String|Array|Object} key Header key or a list of key value pairs
   * @param {String} value Header value
   * @return {Object} current node
   */
  setHeader(key, value) {
    let added = false,
      headerValue;

    // Allow setting multiple headers at once
    if (!value && key && typeof key === 'object') {
      // allow {key:'content-type', value: 'text/plain'}
      if (key.key && 'value' in key) {
        this.setHeader(key.key, key.value);
      } else if (Array.isArray(key)) {
        // allow [{key:'content-type', value: 'text/plain'}]
        key.forEach(i => {
          this.setHeader(i.key, i.value);
        });
      } else {
        // allow {'content-type': 'text/plain'}
        Object.keys(key).forEach(i => {
          this.setHeader(i, key[i]);
        });
      }
      return this;
    }

    key = this._normalizeHeaderKey(key);

    headerValue = {
      key,
      value
    };

    // Check if the value exists and overwrite
    for (let i = 0, len = this._headers.length; i < len; i++) {
      if (this._headers[i].key === key) {
        if (!added) {
          // replace the first match
          this._headers[i] = headerValue;
          added = true;
        } else {
          // remove following matches
          this._headers.splice(i, 1);
          i--;
          len--;
        }
      }
    }

    // match not found, append the value
    if (!added) {
      this._headers.push(headerValue);
    }

    return this;
  }

  /**
   * Adds a header value. If the value for selected key exists, the value is appended
   * as a new field and old one is not touched.
   * You can set multiple values as well by using [{key:'', value:''}] or
   * {key: 'value'} as the first argument.
   *
   * @param {String|Array|Object} key Header key or a list of key value pairs
   * @param {String} value Header value
   * @return {Object} current node
   */
  addHeader(key, value) {
    // allow {'content-type': 'text/plain'}
    Object.keys(key).forEach(i => {
      this.addHeader(i, key[i]);
    });
    return this;
  }

  /**
   * Retrieves the first mathcing value of a selected key
   *
   * @param {String} key Key to search for
   * @retun {String} Value for the key
   */
  getHeader(key) {
    key = this._normalizeHeaderKey(key);
    for (let i = 0, len = this._headers.length; i < len; i++) {
      if (this._headers[i].key === key) {
        return this._headers[i].value;
      }
    }
  }

  /**
   * Sets body content for current node. If the value is a string, charset is added automatically
   * to Content-Type (if it is text/*). If the value is a Buffer, you need to specify
   * the charset yourself
   *
   * @param (String|Buffer) content Body content
   * @return {Object} current node
   */
  setContent(content) {
    this.content = content;
    this._isPlainText = mimeFuncs.isPlainText(this.content);
    return this;
  }

  getTransferEncoding() {
    let transferEncoding = false;

    if (this.content) {
      transferEncoding = (this.getHeader('Content-Transfer-Encoding') || '').toString().toLowerCase().trim();
      if (!transferEncoding || !['base64', 'quoted-printable'].includes(transferEncoding)) {
        // detect preferred encoding for string value
        transferEncoding = this._getTextEncoding(this.content) === 'Q' ? 'quoted-printable' : 'base64';
      }
    }
    return transferEncoding;
  }

  /**
   * Builds the header block for the mime node. Append \r\n\r\n before writing the content
   *
   * @returns {String} Headers
   */
  buildHeaders() {
    let transferEncoding = this.getTransferEncoding();
    let headers = [];

    this.setHeader('Content-Transfer-Encoding', transferEncoding);

    // Ensure mandatory header fields
    if (this.rootNode === this) {
      if (!this.getHeader('Date')) {
        this.setHeader('Date', this.date.toUTCString().replace(/GMT/, '+0000'));
      }

      // ensure that Message-Id is present
      this.messageId();

      if (!this.getHeader('MIME-Version')) {
        this.setHeader('MIME-Version', '1.0');
      }
    }

    this._headers.forEach(header => {
      let key = header.key;
      let value = header.value;
      let structured;

      //只列举 'Content-Type' 的情况
      structured = mimeFuncs.parseHeaderValue(value);

      this._handleContentType(structured);

      value = mimeFuncs.buildHeaderValue(structured);
      value = this._encodeHeaderValue(key, value);
      headers.push(mimeFuncs.foldLines(key + ': ' + value, 76));
    });

    return headers.join('\r\n');
  }

  /**
   * Streams the rfc2822 message from the current node. If this is a root node,
   * mandatory header fields are set if missing (Date, Message-Id, MIME-Version)
   *
   * @return {String} Compiled message
   */
  //位置：mime-node.js
  //以 rfc2822 标准创建stream对象
  //http://blog.chinaunix.net/uid-8532343-id-2029221.html
  createReadStream(options) {
    options = options || {};

    let stream = new PassThrough(options);
    let outputStream = stream;
    let transform;

    this.stream(stream, options, err => {
      if (err) {
        outputStream.emit('error', err);
        return;
      }
      stream.end();
    });

    for (let i = 0, len = this._transforms.length; i < len; i++) {
      transform = typeof this._transforms[i] === 'function' ? this._transforms[i]() : this._transforms[i];
      outputStream.once('error', err => {
        transform.emit('error', err);
      });
      outputStream = outputStream.pipe(transform);
    }

    // ensure terminating newline after possible user transforms
    transform = new LastNewline();
    outputStream.once('error', err => {
      transform.emit('error', err);
    });
    outputStream = outputStream.pipe(transform);

    // dkim and stuff
    for (let i = 0, len = this._processFuncs.length; i < len; i++) {
      transform = this._processFuncs[i];
      outputStream = transform(outputStream);
    }

    return outputStream;
  }
  //位置：mime-node.js
  stream(outputStream, options, done) {
    let transferEncoding = this.getTransferEncoding();
    let contentStream;
    let localStream;

    // protect actual callback against multiple triggering
    let returned = false;
    let callback = err => {
      if (returned) {
        return;
      }
      returned = true;
      done(err);
    };

    // for multipart nodes, push child nodes
    // for content nodes end the stream
    let finalize = () => {
      let childId = 0;
      let processChildNode = () => {
        if (childId >= this.childNodes.length) {
          outputStream.write('\r\n--' + this.boundary + '--\r\n');
          return callback();
        }
        let child = this.childNodes[childId++];
        outputStream.write((childId > 1 ? '\r\n' : '') + '--' + this.boundary + '\r\n');
        child.stream(outputStream, options, err => {
          if (err) {
            return callback(err);
          }
          setImmediate(processChildNode);
        });
      };

      if (this.multipart) {
        setImmediate(processChildNode);
      } else {
        return callback();
      }
    };

    // pushes node content
    let sendContent = () => {
      let createStream = () => {
        contentStream = new (transferEncoding === 'base64' ? base64 : qp).Encoder(options);

        contentStream.pipe(outputStream, {
          end: false
        });
        contentStream.once('end', finalize);
        contentStream.once('error', err => callback(err));

        localStream = this._getStream(this.content);
        localStream.pipe(contentStream);

        localStream.once('error', err => callback(err));
      };
      setImmediate(createStream);

    };


    outputStream.write(this.buildHeaders() + '\r\n\r\n');
    setImmediate(sendContent);
  }

  /**
   * Generates and returns SMTP envelope with the sender address and a list of recipients addresses
   *
   * @return {Object} SMTP envelope in the form of {from: 'from@example.com', to: ['to@example.com']}
   */
  getEnvelope() {
    if (this._envelope) {
      return this._envelope;
    }

    let envelope = {
      from: false,
      to: []
    };
    this._headers.forEach(header => {
      let list = [];
      if (header.key === 'From' || (!envelope.from && ['Reply-To', 'Sender'].includes(header.key))) {
        this._convertAddresses(this._parseAddresses(header.value), list);
        if (list.length && list[0]) {
          envelope.from = list[0].address;
        }
      } else if (['To', 'Cc', 'Bcc'].includes(header.key)) {
        this._convertAddresses(this._parseAddresses(header.value), envelope.to);
      }
    });

    envelope.to = envelope.to.map(to => to.address);

    return envelope;
  }

  /**
   * Returns Message-Id value. If it does not exist, then creates one
   *
   * @return {String} Message-Id value
   */
  messageId() {
    let messageId = this.getHeader('Message-ID');
    // You really should define your own Message-Id field!
    if (!messageId) {
      messageId = this._generateMessageId();
      this.setHeader('Message-ID', messageId);
    }
    return messageId;
  }

  /**
   * Sets pregenerated content that will be used as the output of this node
   *
   * @param {String|Buffer|Stream} Raw MIME contents
   */
  setRaw(raw) {
    this._raw = raw;

    if (this._raw && typeof this._raw.pipe === 'function') {
      // pre-stream handler. might be triggered if a stream is set as content
      // and 'error' fires before anything is done with this stream
      this._contentErrorHandler = err => {
        this._raw.removeListener('error', this._contentErrorHandler);
        this._raw = err;
      };
      this._raw.once('error', this._contentErrorHandler);
    }

    return this;
  }

  /////// PRIVATE METHODS

  /**
   * Detects and returns handle to a stream related with the content.
   *
   * @param {Mixed} content Node content
   * @returns {Object} Stream object
   */
  _getStream(content) {
    let contentStream;
    // pass string or buffer content as a stream
    contentStream = new PassThrough();
    setImmediate(() => contentStream.end(content || ''));
    return contentStream;

  }

  /**
   * Parses addresses. Takes in a single address or an array or an
   * array of address arrays (eg. To: [[first group], [second group],...])
   *
   * @param {Mixed} addresses Addresses to be parsed
   * @return {Array} An array of address objects
   */
  _parseAddresses(addresses) {
    return [].concat.apply(
      [],
      [].concat(addresses).map(address => {
        // eslint-disable-line prefer-spread
        if (address && address.address) {
          address.address = this._normalizeAddress(address.address);
          address.name = address.name || '';
          return [address];
        }
        return addressparser(address);
      })
    );
  }

  /**
   * Normalizes a header key, uses Camel-Case form, except for uppercase MIME-
   *
   * @param {String} key Key to be normalized
   * @return {String} key in Camel-Case form
   */
  _normalizeHeaderKey(key) {
    key = (key || '')
      .toString()
      // no newlines in keys
      .replace(/\r?\n|\r/g, ' ')
      .trim()
      .toLowerCase()
      // use uppercase words, except MIME
      .replace(/^X-SMTPAPI$|^(MIME|DKIM)\b|^[a-z]|-(SPF|FBL|ID|MD5)$|-[a-z]/gi, c => c.toUpperCase())
      // special case
      .replace(/^Content-Features$/i, 'Content-features');

    return key;
  }

  /**
   * Checks if the content type is multipart and defines boundary if needed.
   * Doesn't return anything, modifies object argument instead.
   *
   * @param {Object} structured Parsed header value for 'Content-Type' key
   */
  _handleContentType(structured) {
    this.contentType = structured.value.trim().toLowerCase();

    this.multipart = /^multipart\//i.test(this.contentType) ? this.contentType.substr(this.contentType.indexOf('/') + 1) : false;

    if (this.multipart) {
      this.boundary = structured.params.boundary = structured.params.boundary || this.boundary || this._generateBoundary();
    } else {
      this.boundary = false;
    }
  }

  /**
   * Generates a multipart boundary value
   *
   * @return {String} boundary value
   */
  _generateBoundary() {
    return this.rootNode.boundaryPrefix + '-' + this.rootNode.baseBoundary + '-Part_' + this._nodeId;
  }

  /**
   * Encodes a header value for use in the generated rfc2822 email.
   *
   * @param {String} key Header key
   * @param {String} value Header value
   */
  _encodeHeaderValue(key, value) {
    // key = this._normalizeHeaderKey(key);

    // switch (key) {
    //   // Structured headers
    //   case 'From':
    //   case 'Sender':
    //   case 'To':
    //   case 'Cc':
    //   case 'Bcc':
    //   case 'Reply-To':
    //     return this._convertAddresses(this._parseAddresses(value));
    //
    //   // values enclosed in <>
    //   case 'Message-ID':
    //   case 'In-Reply-To':
    //   case 'Content-Id':
    //     value = (value || '').toString().replace(/\r?\n|\r/g, ' ');
    //
    //     if (value.charAt(0) !== '<') {
    //       value = '<' + value;
    //     }
    //
    //     if (value.charAt(value.length - 1) !== '>') {
    //       value = value + '>';
    //     }
    //     return value;
    //
    //   // space separated list of values enclosed in <>
    //   case 'References':
    //     value = [].concat
    //       .apply(
    //         [],
    //         [].concat(value || '').map(elm => {
    //           // eslint-disable-line prefer-spread
    //           elm = (elm || '')
    //             .toString()
    //             .replace(/\r?\n|\r/g, ' ')
    //             .trim();
    //           return elm.replace(/<[^>]*>/g, str => str.replace(/\s/g, '')).split(/\s+/);
    //         })
    //       )
    //       .map(elm => {
    //         if (elm.charAt(0) !== '<') {
    //           elm = '<' + elm;
    //         }
    //         if (elm.charAt(elm.length - 1) !== '>') {
    //           elm = elm + '>';
    //         }
    //         return elm;
    //       });
    //
    //     return value.join(' ').trim();
    //
    //   case 'Date':
    //     if (Object.prototype.toString.call(value) === '[object Date]') {
    //       return value.toUTCString().replace(/GMT/, '+0000');
    //     }
    //
    //     value = (value || '').toString().replace(/\r?\n|\r/g, ' ');
    //     return this._encodeWords(value);
    //
    //   default:
        value = (value || '').toString().replace(/\r?\n|\r/g, ' ');
        // encodeWords only encodes if needed, otherwise the original string is returned
        return this._encodeWords(value);
    // }
  }

  /**
   * Rebuilds address object using punycode and other adjustments
   *
   * @param {Array} addresses An array of address objects
   * @param {Array} [uniqueList] An array to be populated with addresses
   * @return {String} address string
   */
  _convertAddresses(addresses, uniqueList) {
    let values = [];

    uniqueList = uniqueList || [];

    [].concat(addresses || []).forEach(address => {
      if (address.address) {
        address.address = this._normalizeAddress(address.address);

        if (!address.name) {
          values.push(address.address);
        }
        // else if (address.name) {
          // values.push(this._encodeAddressName(address.name) + ' <' + address.address + '>');
        // }

        if (address.address) {
          if (!uniqueList.filter(a => a.address === address.address).length) {
            uniqueList.push(address);
          }
        }
      }
      // else if (address.group) {
        // values.push(
        //   this._encodeAddressName(address.name) + ':' + (address.group.length ? this._convertAddresses(address.group, uniqueList) : '').trim() + ';'
        // );
      // }
    });

    return values.join(', ');
  }

  /**
   * Normalizes an email address
   *
   * @param {Array} address An array of address objects
   * @return {String} address string
   */
  _normalizeAddress(address) {
    address = (address || '').toString().trim();

    let lastAt = address.lastIndexOf('@');
    if (lastAt < 0) {
      // Bare username
      return address;
    }
    let user = address.substr(0, lastAt);
    let domain = address.substr(lastAt + 1);

    // Usernames are not touched and are kept as is even if these include unicode
    // Domains are punycoded by default
    // 'jõgeva.ee' will be converted to 'xn--jgeva-dua.ee'
    // non-unicode domains are left as is

    return user + '@' + punycode.toASCII(domain.toLowerCase());
  }

  /**
   * If needed, mime encodes the name part
   *
   * @param {String} name Name part of an address
   * @returns {String} Mime word encoded string if needed
   */
  // _encodeAddressName(name) {
  //   if (!/^[\w ']*$/.test(name)) {
  //     if (/^[\x20-\x7e]*$/.test(name)) {
  //       return '"' + name.replace(/([\\"])/g, '\\$1') + '"';
  //     } else {
  //       return mimeFuncs.encodeWord(name, this._getTextEncoding(name), 52);
  //     }
  //   }
  //   return name;
  // }

  /**
   * If needed, mime encodes the name part
   *
   * @param {String} name Name part of an address
   * @returns {String} Mime word encoded string if needed
   */
  _encodeWords(value) {
    // set encodeAll parameter to true even though it is against the recommendation of RFC2047,
    // by default only words that include non-ascii should be converted into encoded words
    // but some clients (eg. Zimbra) do not handle it properly and remove surrounding whitespace
    return mimeFuncs.encodeWords(value, this._getTextEncoding(value), 52, true);
  }

  /**
   * Detects best mime encoding for a text value
   *
   * @param {String} value Value to check for
   * @return {String} either 'Q' or 'B'
   */
  _getTextEncoding(value) {
    value = (value || '').toString();

    let encoding = this.textEncoding;
    let latinLen;
    let nonLatinLen;

    if (!encoding) {
      // count latin alphabet symbols and 8-bit range symbols + control symbols
      // if there are more latin characters, then use quoted-printable
      // encoding, otherwise use base64
      nonLatinLen = (value.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\u0080-\uFFFF]/g) || []).length; // eslint-disable-line no-control-regex
      latinLen = (value.match(/[a-z]/gi) || []).length;
      // if there are more latin symbols than binary/unicode, then prefer Q, otherwise B
      encoding = nonLatinLen < latinLen ? 'Q' : 'B';
    }
    return encoding;
  }

  /**
   * Generates a message id
   *
   * @return {String} Random Message-ID value
   */
  _generateMessageId() {
    return (
      '<' +
      [2, 2, 2, 6].reduce(
        // crux to generate UUID-like random strings
        (prev, len) => prev + '-' + crypto.randomBytes(len).toString('hex'),
        crypto.randomBytes(4).toString('hex')
      ) +
      '@' +
      // try to use the domain of the FROM address or fallback to server hostname
      (this.getEnvelope().from || this.hostname || os.hostname() || 'localhost').split('@').pop() +
      '>'
    );
  }
}

module.exports = MimeNode;
