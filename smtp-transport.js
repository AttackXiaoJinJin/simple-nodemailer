const EventEmitter = require('events');
const SMTPConnection = require('./smtp-connection');

/**
 * Creates a SMTP transport object for Nodemailer
 *
 * @constructor
 * @param {Object} options Connection options
 */
class SMTPTransport extends EventEmitter {
  //host,port,secure,auth:{user,pass}
  constructor(options) {
    super();
    //初始化options、auth
    this.options = {...options}
    //{
    //       type: 'LOGIN',
    //       user: authData.user,
    //       credentials: {
    //         user: authData.user,
    //         pass: authData.pass,
    //       },
    //       method: false
    //     }
    this.auth = this.getAuth();
  }

  /**
   * Placeholder function for creating proxy sockets. This method immediatelly returns
   * without a socket
   *
   * @param {Object} options Connection options
   * @param {Function} callback Callback function to run with the socket keys
   */
  //用于创建 proxy sockets 的函数
  getSocket(options, callback) {
    // return immediatelly
    //在I/O阶段后立即执行
    return setImmediate(() => callback(null, false));
  }

  getAuth() {
    let authData = {...this.options.auth};
    return {
      type: 'LOGIN',
      user: authData.user,
      credentials: {
        user: authData.user,
        pass: authData.pass,
      },
      method: false
    };
  }

  /**
   * Sends an e-mail using the selected settings
   *
   * @param {Object} mail Mail object
   * @param {Function} callback Callback function
   */
  /*核心函数*/
  //根据data发送email
  send(mail, callback) {
    this.getSocket(this.options, (err, socketOptions) => {
      if (err) {
        return callback(err);
      }

      let returned = false;
      let options = this.options;
      //新建 SMTP连接实例，并执行 connect()
      let connection = new SMTPConnection(options);
      //注册只执行一次的事件
      //发生错误就关闭连接
      connection.once('error', err => {
        if (returned) {
          return;
        }
        returned = true;
        connection.close();
        return callback(err);
      });

      connection.once('end', () => {
        if (returned) {
          return;
        }

        let timer = setTimeout(() => {
          if (returned) {
            return;
          }
          returned = true;
          // still have not returned, this means we have an unexpected connection close
          let err = new Error('Unexpected socket close');
          if (connection && connection._socket && connection._socket.upgrading) {
            // starttls connection errors
            err.code = 'ETLS';
          }
          callback(err);
        }, 1000);

        try {
          //让timer不阻止node进程的退出
          timer.unref();
        } catch (E) {
          // Ignore. Happens on envs with non-node timer implementation
        }
      });

      let sendMessage = () => {
        let envelope = mail.message.getEnvelope(); //{from:'发送者',to:['接收者1','接收者2',xxx]}
        let messageId = mail.message.messageId(); //<d40a4801-b68f-b2c4-5706-8a7a0b4aac34@qq.cn>

        let recipients = [].concat(envelope.to || []);
        if (recipients.length > 3) {
          recipients.push('...and ' + recipients.splice(2).length + ' more');
        }
        //null
        if (mail.data.dsn) {
          envelope.dsn = mail.data.dsn;
        }
        //mail.message即处理过的邮件内容
        connection.send(envelope, mail.message.createReadStream(), (err, info) => {
          returned = true;
          connection.close();
          if (err) {
            console.log(err,'err120')
            return callback(err);
          }
          info.envelope = {
            from: envelope.from,
            to: envelope.to
          };
          info.messageId = messageId;
          try {
            return callback(null, info); //callback是errorHandler，不用管
          } catch (E) {
          }
        });
      };

      //先执行内部代码，再执行callback
      connection.connect(() => {
        if (returned) {
          return;
        }
        // {
        //   type: 'LOGIN',
        //   user: authData.user,
        //   credentials: {user:'xxx',pass: 'xxx',},
        //   method: false
        // }
        let auth = this.getAuth(mail.data.auth);
        //走这边
        if (auth && (connection.allowsAuth || options.forceAuth)) {
          connection.login(auth, err => {
            if (auth && auth !== this.auth && auth.oauth2) {
              auth.oauth2.removeAllListeners();
            }
            if (returned) {
              return;
            }

            if (err) {
              returned = true;
              connection.close();
              return callback(err);
            }
            //auth登录成功后，发送邮件
            sendMessage();
          });
        } else {
          sendMessage();
        }
      });
    });
  }

}

// expose to the world
module.exports = SMTPTransport;
