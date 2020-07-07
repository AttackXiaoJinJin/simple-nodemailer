const EventEmitter = require('events');
const SMTPConnection = require('./smtp-connection');
const shared = require('./shared');

/**
 * Creates a SMTP transport object for Nodemailer
 *
 * @constructor
 * @param {Object} options Connection options
 */
class SMTPTransport extends EventEmitter {
  constructor(options) {
    super();
    this.options = {...options}

    this.logger = shared.getLogger(this.options, {
      component: this.options.component || 'smtp-transport'
    });

    this.auth = this.getAuth();
  }

  /**
   * Placeholder function for creating proxy sockets. This method immediatelly returns
   * without a socket
   *
   * @param {Object} options Connection options
   * @param {Function} callback Callback function to run with the socket keys
   */
  getSocket(options, callback) {
    // return immediatelly
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
  send(mail, callback) {
    this.getSocket(this.options, (err, socketOptions) => {
      if (err) {
        return callback(err);
      }

      let returned = false;
      let options = this.options;
      if (socketOptions && socketOptions.connection) {
        this.logger.info(
          {
            tnx: 'proxy',
            remoteAddress: socketOptions.connection.remoteAddress,
            remotePort: socketOptions.connection.remotePort,
            destHost: options.host || '',
            destPort: options.port || '',
            action: 'connected'
          },
          'Using proxied socket from %s:%s to %s:%s',
          socketOptions.connection.remoteAddress,
          socketOptions.connection.remotePort,
          options.host || '',
          options.port || ''
        );

        // only copy options if we need to modify it
        options = shared.assign(false, options);
        Object.keys(socketOptions).forEach(key => {
          options[key] = socketOptions[key];
        });
      }

      let connection = new SMTPConnection(options);

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
          timer.unref();
        } catch (E) {
          // Ignore. Happens on envs with non-node timer implementation
        }
      });

      let sendMessage = () => {
        let envelope = mail.message.getEnvelope();
        let messageId = mail.message.messageId();

        let recipients = [].concat(envelope.to || []);
        if (recipients.length > 3) {
          recipients.push('...and ' + recipients.splice(2).length + ' more');
        }

        if (mail.data.dsn) {
          envelope.dsn = mail.data.dsn;
        }

        this.logger.info(
          {
            tnx: 'send',
            messageId
          },
          'Sending message %s to <%s>',
          messageId,
          recipients.join(', ')
        );

        connection.send(envelope, mail.message.createReadStream(), (err, info) => {
          returned = true;
          connection.close();
          if (err) {
            this.logger.error(
              {
                err,
                tnx: 'send'
              },
              'Send error for %s: %s',
              messageId,
              err.message
            );
            return callback(err);
          }
          info.envelope = {
            from: envelope.from,
            to: envelope.to
          };
          info.messageId = messageId;
          try {
            return callback(null, info);
          } catch (E) {
            this.logger.error(
              {
                err: E,
                tnx: 'callback'
              },
              'Callback error for %s: %s',
              messageId,
              E.message
            );
          }
        });
      };

      connection.connect(() => {
        if (returned) {
          return;
        }

        let auth = this.getAuth(mail.data.auth);

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
