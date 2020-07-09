#### 注意
在下载该库后，记得添加`config`文件，内容为：
```
const config={
  user: '你的邮箱',
  pass: '你的smtp密码，不要外泄',
}

module.exports=config
```
#### 如何运行
在添加完`config`文件后，终端输入`node index.js`即可

#### 说明
本库是将[nodemailer](https://github.com/nodemailer/nodemailer)删减后的代码，并不是基于`nodemailer`的封装，仅供交流学习使用。
