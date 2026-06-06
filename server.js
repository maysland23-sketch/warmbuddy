require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const cookieParser = require('cookie-parser');
app.use(cookieParser());

// 简易密码验证中间件
const ACCESS_PASSWORD = '851121'; // 改成你自己的，比如 'mays2026'

app.use((req, res, next) => {
  // 如果是请求 API 或者已经登录过，直接放行
  if (req.path.startsWith('/api/chat') || req.cookies?.auth === 'true') {
    return next();
  }

  // 如果请求带了正确的密码参数
  if (req.query.pwd === ACCESS_PASSWORD) {
    res.cookie('auth', 'true', { maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30天免密
    return res.redirect('/');
  }

  // 没有密码就显示输入页面
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>暖伴</title>
    <style>body{background:#F7F5F1;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;}
    input{padding:12px;border:1px solid #ddd;border-radius:8px;width:200px;margin-right:8px;}
    button{padding:12px 20px;background:#6B7C93;color:white;border:none;border-radius:8px;}</style>
    </head><body><form method="get">
    <input type="password" name="pwd" placeholder="输入访问密码"><button type="submit">进入</button>
    </form></body></html>
  `);
});

// 只保留聊天这一个核心接口
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body; // 前端发来的对话历史

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: '缺少 messages 字段' });
  }

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',   // 可用 deepseek-reasoner 切换
        messages: messages,
        stream: false
      })
    });

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    // 返回完整的 AI 回复
    const reply = data.choices[0].message;
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '后端请求失败' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 后端已启动：http://localhost:${PORT}`);
});
