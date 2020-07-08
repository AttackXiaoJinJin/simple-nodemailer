/**
 * Converts tokens for a single address into an address object
 *
 * @param {Array} tokens Tokens object
 * @return {Object} Address object
 */
function _handleAddress(tokens) {
  let token;
  let state = 'text';
  let address;
  let addresses = [];
  let data = {
    address: [],
    comment: [],
    group: [],
    text: []
  };
  let i;
  let len;

  // Filter out <addresses>, (comments) and regular text
  for (i = 0, len = tokens.length; i < len; i++) {
    token = tokens[i];
    data[state].push(token.value);
  }

  // If no address was found, try to detect one from regular text
  if (!data.address.length && data.text.length) {
    for (i = data.text.length - 1; i >= 0; i--) {
      if (data.text[i].match(/^[^@\s]+@[^@\s]+$/)) {
        data.address = data.text.splice(i, 1);
        break;
      }
    }
  }

  // Join values with spaces
  data.text = data.text.join(' ');
  data.address = data.address.join(' ');

  address = {
    address: data.address || data.text || '',
    name: data.text || data.address || ''
  };

  if (address.address === address.name) {
    address.name = '';
  }

  addresses.push(address);

  return addresses;
}

/**
 * Creates a Tokenizer object for tokenizing address field strings
 *
 * @constructor
 * @param {String} str Address field string
 */
class Tokenizer {
  constructor(str) {
    this.str = (str || '').toString();
    this.node = null;
    this.list = [];

  }

  /**
   * Tokenizes the original input string
   *
   * @return {Array} An array of operator|text tokens
   */
  tokenize() {
    let chr,
      list = [];
    for (let i = 0, len = this.str.length; i < len; i++) {
      chr = this.str.charAt(i);
      this.checkChar(chr);
    }

    this.list.forEach(node => {
      node.value = (node.value || '').toString().trim();
      if (node.value) {
        list.push(node);
      }
    });

    return list;
  }

  /**
   * Checks if a character is an operator or text and acts accordingly
   *
   * @param {String} chr Character from the address field
   */
  checkChar(chr) {
    if (!this.node) {
      this.node = {
        type: 'text',
        value: ''
      };
      this.list.push(this.node);
    }

    this.node.value += chr;
  }
}

/**
 * Parses structured e-mail addresses from an address field
 *
 * Example:
 *
 *    'Name <address@domain>'
 *
 * will be converted to
 *
 *     [{name: 'Name', address: 'address@domain'}]
 *
 * @param {String} str Address field
 * @return {Array} An array of address objects
 */
function addressparser(str, options) {
  let tokenizer = new Tokenizer(str);
  let tokens = tokenizer.tokenize();

  let addresses = [];
  let address = [];
  let parsedAddresses = [];

  tokens.forEach(token => {
      address.push(token);
  });

  if (address.length) {
    addresses.push(address);
  }

  addresses.forEach(address => {
    address = _handleAddress(address);
    if (address.length) {
      parsedAddresses = parsedAddresses.concat(address);
    }
  });

  return parsedAddresses;
}

// expose to the world
module.exports = addressparser;
