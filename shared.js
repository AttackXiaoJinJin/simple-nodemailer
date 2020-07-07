const urllib = require('url');
const dns = require('dns');
const net = require('net');

const DNS_TTL = 5 * 60 * 1000;

const resolver = (family, hostname, callback) => {
  dns['resolve' + family](hostname, (err, addresses) => {
    if (err) {
      switch (err.code) {
        case dns.NODATA:
        case dns.NOTFOUND:
        case dns.NOTIMP:
        case dns.SERVFAIL:
        case dns.CONNREFUSED:
        case 'EAI_AGAIN':
          return callback(null, []);
      }
      return callback(err);
    }
    return callback(null, Array.isArray(addresses) ? addresses : [].concat(addresses || []));
  });
};

const dnsCache = (module.exports.dnsCache = new Map());
module.exports.resolveHostname = (options, callback) => {
  options = options || {};

  if (!options.host || net.isIP(options.host)) {
    // nothing to do here
    let value = {
      host: options.host,
      servername: options.servername || false
    };
    return callback(null, value);
  }

  let cached;

  if (dnsCache.has(options.host)) {
    cached = dnsCache.get(options.host);
    if (!cached.expires || cached.expires >= Date.now()) {
      return callback(null, {
        host: cached.value.host,
        servername: cached.value.servername,
        _cached: true
      });
    }
  }

  resolver(4, options.host, (err, addresses) => {
    if (err) {
      if (cached) {
        // ignore error, use expired value
        return callback(null, cached.value);
      }
      return callback(err);
    }
    if (addresses && addresses.length) {
      let value = {
        host: addresses[0] || options.host,
        servername: options.servername || options.host
      };
      dnsCache.set(options.host, {
        value,
        expires: Date.now() + DNS_TTL
      });
      return callback(null, value);
    }

    resolver(6, options.host, (err, addresses) => {
      if (err) {
        if (cached) {
          // ignore error, use expired value
          return callback(null, cached.value);
        }
        return callback(err);
      }
      if (addresses && addresses.length) {
        let value = {
          host: addresses[0] || options.host,
          servername: options.servername || options.host
        };
        dnsCache.set(options.host, {
          value,
          expires: Date.now() + DNS_TTL
        });
        return callback(null, value);
      }

      try {
        dns.lookup(options.host, {}, (err, address) => {
          if (err) {
            if (cached) {
              // ignore error, use expired value
              return callback(null, cached.value);
            }
            return callback(err);
          }

          if (!address && cached) {
            // nothing was found, fallback to cached value
            return callback(null, cached.value);
          }

          let value = {
            host: address || options.host,
            servername: options.servername || options.host
          };
          dnsCache.set(options.host, {
            value,
            expires: Date.now() + DNS_TTL
          });
          return callback(null, value);
        });
      } catch (err) {
        if (cached) {
          // ignore error, use expired value
          return callback(null, cached.value);
        }
        return callback(err);
      }
    });
  });
};
/**
 * Parses connection url to a structured configuration object
 *
 * @param {String} str Connection url
 * @return {Object} Configuration object
 */
module.exports.parseConnectionUrl = str => {
  str = str || '';
  let options = {};

  [urllib.parse(str, true)].forEach(url => {
    let auth;

    switch (url.protocol) {
      case 'smtp:':
        options.secure = false;
        break;
      case 'smtps:':
        options.secure = true;
        break;
      case 'direct:':
        options.direct = true;
        break;
    }

    if (!isNaN(url.port) && Number(url.port)) {
      options.port = Number(url.port);
    }

    if (url.hostname) {
      options.host = url.hostname;
    }

    if (url.auth) {
      auth = url.auth.split(':');

      if (!options.auth) {
        options.auth = {};
      }

      options.auth.user = auth.shift();
      options.auth.pass = auth.join(':');
    }

    Object.keys(url.query || {}).forEach(key => {
      let obj = options;
      let lKey = key;
      let value = url.query[key];

      if (!isNaN(value)) {
        value = Number(value);
      }

      switch (value) {
        case 'true':
          value = true;
          break;
        case 'false':
          value = false;
          break;
      }

      // tls is nested object
      if (key.indexOf('tls.') === 0) {
        lKey = key.substr(4);
        if (!options.tls) {
          options.tls = {};
        }
        obj = options.tls;
      } else if (key.indexOf('.') >= 0) {
        // ignore nested properties besides tls
        return;
      }

      if (!(lKey in obj)) {
        obj[lKey] = value;
      }
    });
  });

  return options;
};


/**
 * Wrapper for creating a callback that either resolves or rejects a promise
 * based on input
 *
 * @param {Function} resolve Function to run if callback is called
 * @param {Function} reject Function to run if callback ends with an error
 */
module.exports.callbackPromise = (resolve, reject) =>
  function() {
    let args = Array.from(arguments);
    let err = args.shift();
    if (err) {
      reject(err);
    } else {
      resolve(...args);
    }
  };

/**
 * Resolves a String or a Buffer value for content value. Useful if the value
 * is a Stream or a file or an URL. If the value is a Stream, overwrites
 * the stream object with the resolved value (you can't stream a value twice).
 *
 * This is useful when you want to create a plugin that needs a content value,
 * for example the `html` or `text` value as a String or a Buffer but not as
 * a file path or an URL.
 *
 * @param {Object} data An object or an Array you want to resolve an element for
 * @param {String|Number} key Property name or an Array index
 * @param {Function} callback Callback function with (err, value)
 */
module.exports.resolveContent = (data, key, callback) => {
  let promise;
  //获取html
  let content = data[key];

  // default action, return as is
  setImmediate(() => callback(null, content));

  return promise;
};

/**
 * Copies properties from source objects to target objects
 */
module.exports.assign = function(/* target, ... sources */) {
  let args = Array.from(arguments);
  let target = args.shift() || {};

  args.forEach(source => {
    Object.keys(source || {}).forEach(key => {
      if (['tls', 'auth'].includes(key) && source[key] && typeof source[key] === 'object') {
        // tls and auth are special keys that need to be enumerated separately
        // other objects are passed as is
        if (!target[key]) {
          // ensure that target has this key
          target[key] = {};
        }
        Object.keys(source[key]).forEach(subKey => {
          target[key][subKey] = source[key][subKey];
        });
      } else {
        target[key] = source[key];
      }
    });
  });
  return target;
};

module.exports.encodeXText = str => {
  // ! 0x21
  // + 0x2B
  // = 0x3D
  // ~ 0x7E
  if (!/[^\x21-\x2A\x2C-\x3C\x3E-\x7E]/.test(str)) {
    return str;
  }
  let buf = Buffer.from(str);
  let result = '';
  for (let i = 0, len = buf.length; i < len; i++) {
    let c = buf[i];
    if (c < 0x21 || c > 0x7e || c === 0x2b || c === 0x3d) {
      result += '+' + (c < 0x10 ? '0' : '') + c.toString(16).toUpperCase();
    } else {
      result += String.fromCharCode(c);
    }
  }
  return result;
};

