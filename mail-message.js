class MailMessage {
  constructor(mailer, data) {
    this.data = {};

    data = data || {};
    Object.keys(data).forEach(key => {
      this.data[key] = data[key];
    });

    this.data.headers = {};
    //data:{
    // from:'xxx', 发送方
    // to:'xxx', 接收方
    // subject:'xxx', 标题
    // content:'xxx', 内容
    // headers:{},
    //}
  }

}

module.exports = MailMessage;
