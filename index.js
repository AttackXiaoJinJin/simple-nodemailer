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
  content:'本作男主角，与三笠·阿克曼、爱尔敏·阿诺德是儿时玩伴，拥有强韧的精神力与非凡的行动力，对墙壁外的世界有者比人们都要高的憧憬，从小立志加入调查兵团。在目睹母亲遭巨人吞食后，立誓要驱逐所有巨人。他和儿时玩伴一起受训并认识不少人，以第五名毕业。\n' +
    '托洛斯特区一战中，他为了拯救爱尔敏而遭纯洁巨人吞噬，而后变身为15米高的巨人，开始攻击其他巨人，为训练兵带来生机，进而撤退到罗赛之墙内，却因此被视为怪物。之后协助驻扎兵团用岩石将托洛斯特区大门堵上。夺回托洛斯特区后，被送上军事法庭对其巨人化能力的威胁性进行审判，在调查兵团的解救下，加入调查兵团并接受监督与巨人化相关实验。\n' +
    '第57次墙外调查中，所属的特别作战小组遭到“女巨人”的攻击，惨遭全灭。艾伦变身为巨人与其战斗，也战败被抓，之后被利威尔与三笠救回。虽然调查兵团捉住女巨人，并揪出其身份为亚妮·雷恩哈特，不过她利用女巨人的“硬质化”能力封印自己，因此众人无法取得情报。\n' +
    '厄特加尔城一战后，莱纳及贝尔托特告白其为“铠之巨人”和“超大型巨人”，随后三人变身并交战，艾伦被击败，和尤弥尔一起被掳走。在联合部队前来救出艾伦和尤弥尔时，五年前吃掉母亲的纯洁巨人再度现身在艾伦眼前，在汉尼斯被纯洁巨人吃掉后激发了艾伦的一项能力，可以透过精神来操控其他纯洁巨人，此能力被莱纳等人称为“座标”。艾伦用这项能力压制了铠之巨人，让他的同伴得以撤离。\n' +
    '之后为了修补玛丽亚之墙，努力练习“硬质化”，但失败。因为拥有“始祖巨人”能力而遭到王政府追杀，调查兵团计划将艾伦与希斯特莉亚交给中央宪兵团，以追踪对方，反遭识破而被囚。艾伦从父亲的记忆中了解到五年前其父对雷斯家的行为以及遭其注射让人变成纯洁巨人的液体，并将他吞噬继承了巨人之力。悲愤之虞，希望能献出自身，将“始祖巨人”还给“王家”希斯特莉亚，但被其拒绝。希斯特莉亚的父亲罗德.雷斯在脊髓液被摔碎的情况下自行舔舐了洒落在地上的脊髓液而变成身长120米长超巨型的奇行种巨人导致地下洞穴崩塌，为救将被崩塌的洞穴埋住的同伴，喝下了标有“盔甲”字样的液体，获得了硬质化的能力并救了同伴。其后变身成巨人将大量的炸药丢入由罗德.雷斯变成的巨人的口中使其因高温引爆火药将全身炸碎。\n' +
    '于玛丽亚之墙夺回战中，使用硬质化堵住玛丽亚之墙，随后与调查兵团合力击败莱纳，即将收拾莱纳时，因贝尔托特的支援使调查兵团失去大半的士兵，而艾伦试图以巨人的肉身阻挡超大型巨人却被踢飞至城墙上，其后与爱尔敏合作利合作用佯攻击败贝尔托特。后来因爱尔敏重伤命危请求利威尔将爱尔敏变成巨人吞食贝尔托特，后来因爱尔敏重伤命危请求利威尔将爱尔敏变成巨人吞食贝尔托特却因弗洛克带着重伤的艾尔文前来使利威尔改变主意而与其发争执，后来利威尔选择了爱尔敏使其继承巨人之力。战后，再度回到家中，在地下室里得到父亲的笔记和照片，得知墙内人类为可变成巨人并曾借此统治世界的特殊人种-“艾尔迪亚人（尤弥尔的子民）”，百年前被艾尔迪亚灭国的马莱于百年前战胜后，对想留在大陆的艾尔迪亚人实施隔离政策，之后马莱为了帕拉廸岛的资源，以岛上弗里茨王宣战为借口征召艾尔迪亚儿童作为巨人之力的“容器”，也因此引发玛丽亚之墙陷落等事件。此战一载后，与残兵们参加睽违六年的玛丽亚之墙外调查，并消灭墙外纯洁巨人，与伙伴看到“海”。\n' +
    '于851至854年的3年间，与爱尔敏和吉克派遣的‘反马莱义勇兵’合作，多次将入侵的马莱军舰捕获。于‘雷贝利欧收容区之战’的两年前与韩吉、三笠和希斯特莉亚等人参加艾尔迪亚帝国与希兹尔国之间的会见。在会谈中，希兹尔国代表奇优宓提到艾尔迪亚必须在将军事水平迎头赶上世界水准的期间使用释放墙内纯洁巨人的‘地鸣’来震慑他国，而地鸣的可能条件就是始祖巨人与王血继承者的巨人的存在，因此，王血继承者必须在获得巨人之力后‘尽可能繁衍后代’以保有王血巨人的存在，当时的会议只有艾伦挺身反对。之后艾伦因参与了马莱艾尔迪亚人权组织的会议，得知并了解到了即使是艾尔迪亚的人权团体仍把帕拉迪岛上尤弥尔的子民当成恶魔看待且要予以驱逐，于是下定决心要向全世界的人类开战，于马莱与中东联合的战争结束后，离开同伴并私自伪装成艾尔迪亚战士队的伤兵，并化名为克鲁格，成功潜入马莱国土。',
})












