const nodemailer=require('./nodemailer')
const config=require('./config')
async function sendEMail(option){
  const {email,title,date,content}=option

  //返回的 Mailer 实例
  const transporter =nodemailer.createTransport({
    host: "smtp.exmail.qq.com",
    port: 465,
    secure: true,
    auth: {
      user: config.EmailName,
      pass: config.EmailPwd,
    },
  });

  await transporter.sendMail({
    // from: config.get('EmailName'), // sender address
    // to: config.get('EmailReceive'), // list of receivers
    from: email, // sender address
    to: email, // list of receivers
    subject: title, // 标题
    html: `<div><div>日期：${date}</div><div>内容：${content}</div></div>`, // html body
  });
}

sendEMail({
  email:'jin.chen@fusiontree.cn',
  title:"看下nodemailer原理",
  date:new Date(),
  content:'7月7日晴',
})
