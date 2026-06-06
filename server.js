require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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