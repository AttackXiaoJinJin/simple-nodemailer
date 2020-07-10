const urllib = require('url');
const dns = require('dns');
const net = require('net');

const DNS_TTL = 5 * 60 * 1000;
//1.DNS解析域名，获取ip
const resolver = (family, hostname, callback) => {
  //使用DNS协议为hostname解析IPv4地址
  //dns[resolve4]('smtp.exmail.qq.com',()=>{})
  dns['resolve' + family](hostname, (err, addresses) => {
    //smtp.exmail.qq.com通过DNS解析有三个ip地址
    //addrresses=['113.96.208.92','113.96.232.106','113.96.200.115']
    return callback(null, Array.isArray(addresses) ? addresses : [].concat(addresses || []));
  });
};
//dns缓存
const dnsCache = (module.exports.dnsCache = new Map());

module.exports.resolveHostname = (options, callback) => {
  resolver(4, options.host, (err, addresses) => {
    //addresses即为DNS解析后的ip地址
      let value = {
        host: addresses[0] || options.host,
        servername: options.servername || options.host
      };
      dnsCache.set(options.host, {
        value,
        expires: Date.now() + DNS_TTL
      });
      return callback(null, value);

  });
};

/**
 * Wrapper for creating a callback that either resolves or rejects a promise
 * based on input
 *
 * @param {Function} resolve Function to run if callback is called
 * @param {Function} reject Function to run if callback ends with an error
 */
//通用的初始化 callbackPromise 函数
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

