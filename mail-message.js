const shared = require('./shared');

class MailMessage {
  constructor(mailer, data) {
    this.data = {};

    data = data || {};
    Object.keys(data).forEach(key => {
      this.data[key] = data[key];
    });

    this.data.headers = this.data.headers || {};
  }

  resolveContent(...args) {
    return shared.resolveContent(...args);
  }

}

module.exports = MailMessage;
