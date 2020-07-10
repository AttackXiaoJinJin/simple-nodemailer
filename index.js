const nodemailer=require('./nodemailer')
const config=require('./config')

async function sendEMail(option){
  //根据用户名、密码、qq邮箱smtp地址、端口，新建 mailer 实例
  //比较简单就是初始化属性
  const transporter =nodemailer.createTransport({
    host: "smtp.exmail.qq.com",
    port: 465,
    secure: true,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  const {email,title,date,content}=option

  await transporter.sendMail({
    from: email, // sender address
    to: email, // list of receivers
    subject: title, // 标题
    html: `<div><div>日期：${date}</div><div>内容：${content}</div></div>`, // html body
  });
}

sendEMail({
  email:config.user,
  title:"看下nodemailer原理",
  date:new Date(),
  content:'本作男主角，与三笠·阿克曼、爱尔敏·阿诺德是儿时玩伴，拥有强韧的精神力与非凡的行动力，对墙壁外的世界有者比人们都要高的憧憬，从小立志加入调查兵团。在目睹母亲遭巨人吞食后，立誓要驱逐所有巨人。他和儿时玩伴一起受训并认识不少人，以第五名毕业。\n'
})












