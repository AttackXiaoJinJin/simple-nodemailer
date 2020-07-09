const EventEmitter = require('events');
const shared = require('./shared');
const MailComposer = require('./mail-composer');
const SMTPTransport = require('./smtp-transport');
const MailMessage = require('./mail-message');

/**
 * Creates an object for exposing the Mail API
 * 创建一个用来开放 email API 的object
 *
 * @constructor
 * @param {Object} transporter Transport object instance to pass the mails to
 */
//Mail
class Mailer extends EventEmitter {
  constructor(transporter,options,) {
    super();
    this.options = options

    this._defaultPlugins = {
      compile: [],
      stream: []
    };

    this._userPlugins = {
      compile: [],
      stream: []
    };
    //transporter 即 SMPT 传输实例
    this.transporter = transporter;
    //传输实例的 mailer 属性即 mailer实例
    this.transporter.mailer = this;
  }

  /**
   * Sends an email using the preselected transport object
   *
   * @param {Object} data E-data description
   * @param {Function?} callback Callback to run once the sending succeeded or failed
   */
  //from,to,subject,html
  sendMail(data, callback) {
    let promise;
    //初始化 promiseCallback
    if (!callback) {
      promise = new Promise((resolve, reject) => {
        callback = shared.callbackPromise(resolve, reject);
      });
    }
    //this 即 Mailer实例
    //根据 发送邮件选项 新建 mailMessage 实例
    //data:{ from:'xxx',to:'xxx',subject:'xxx',content:'xxx',headers:{}, },
    //message:mimeNode 实例,
    let mail = new MailMessage(this, data);
    //过程处理
    //1.compile
    //2.stream
    // this._processPlugins('compile', mail, err => {
    //新建 mimeNode 实例
      mail.message = new MailComposer(mail.data).compile();

      // this._processPlugins('stream', mail, err => {
    //SMPT 传输实例的send方法
        this.transporter.send(mail);
      // });
    // });

    return promise;
  }
  //step1:compile
  //step2:stream
  //执行callback
  // _processPlugins(step, mail, callback) {
    // let userPlugins = this._userPlugins[step]
    // let defaultPlugins = this._defaultPlugins[step]
    // let pos = 0;
    // let block = 'default';
    // let processPlugins = () => {
    //   let curplugins = block === 'default' ? defaultPlugins : userPlugins; //[]
    //   // let curplugins =  defaultPlugins
    //   if (pos >= curplugins.length) {
    //     if (block === 'default' && userPlugins.length) {
    //       block = 'user';
    //       pos = 0;
    //       curplugins = userPlugins;
    //     } else {
    // return callback();
    //     }
    //   }
    //   let plugin = curplugins[pos++];
    //   plugin(mail, err => {
    //     // if (err) {
    //     //   return callback(err);
    //     // }
    //     processPlugins();
    //   });
    // };
    //
    // processPlugins();
  // }
}

const nodemailer={}

nodemailer.createTransport=function (options) {
  //host,port,secure,auth:{user,pass}
  //1.通过 option 新建 SMPT 传输实例
  let transporter = new SMTPTransport(options);
  //2.根据 SMPT传输实例， 新建 mail 实例
  return new Mailer(transporter,options);
}


module.exports=nodemailer

