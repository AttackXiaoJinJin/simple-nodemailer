class MailMessage {
  constructor(mailer, data) {
    this.data = {};

    data = data || {};
    Object.keys(data).forEach(key => {
      this.data[key] = data[key];
    });

    this.data.headers = {};
  }

}

module.exports = MailMessage;
