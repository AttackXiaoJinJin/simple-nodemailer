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

    this.transporter = transporter;
    this.transporter.mailer = this;
  }

  /**
   * Sends an email using the preselected transport object
   *
   * @param {Object} data E-data description
   * @param {Function?} callback Callback to run once the sending succeeded or failed
   */
  sendMail(data, callback) {
    let promise;

    if (!callback) {
      promise = new Promise((resolve, reject) => {
        callback = shared.callbackPromise(resolve, reject);
      });
    }

    let mail = new MailMessage(this, data);
    //1.compile
    //2.stream
    this._processPlugins('compile', mail, err => {
      mail.message = new MailComposer(mail.data).compile();

      this._processPlugins('stream', mail, err => {
        this.transporter.send(mail);
      });
    });

    return promise;
  }

  _processPlugins(step, mail, callback) {
    let userPlugins = this._userPlugins[step]
    let defaultPlugins = this._defaultPlugins[step]

    let pos = 0;
    let block = 'default';
    let processPlugins = () => {
      let curplugins = block === 'default' ? defaultPlugins : userPlugins;
      // let curplugins =  defaultPlugins
      if (pos >= curplugins.length) {
        if (block === 'default' && userPlugins.length) {
          block = 'user';
          pos = 0;
          curplugins = userPlugins;
        } else {
          return callback();
        }
      }
      let plugin = curplugins[pos++];
      plugin(mail, err => {
        // if (err) {
        //   return callback(err);
        // }
        processPlugins();
      });
    };

    processPlugins();
  }
}

const nodemailer={}

nodemailer.createTransport=function (transporter) {
  let options=transporter
  //只列出 SMTPTransport 的情况
  transporter = new SMTPTransport(options);
  return new Mailer(transporter,options);
}


module.exports=nodemailer

