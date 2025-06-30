// index_refactored.js – Waka.AI LINE Bot (MongoDB history 版)
// ------------------------------------------------------------
// ● history の読み書きをファイル → MongoDB Atlas に切替え
//    - db.js で export した getColl('history') を利用
// ● その他ロジックはそのまま
// ------------------------------------------------------------

require('dotenv').config();
const express   = require('express');
const axios     = require('axios');
const fs        = require('fs').promises;
const { middleware, Client } = require('@line/bot-sdk');
const { getColl } = require('./db');  // ★ 追加

const app  = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// 固定 ID とプロファイルファイル (profile は後で MongoDB 化予定)
// ------------------------------------------------------------
const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

const MOTHER_PROFILE_FILE = './mother_profile.json';
const YUTO_PROFILE_FILE   = './yuto_profile.json';
const PENDING_REPLY_FILE  = './pending_reply_to_mother.json';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET
};

const client = new Client(config);

//------------------------
// ルート / で Health Check
//------------------------
app.get('/', (req, res) => res.status(200).send('OK'));

//------------------------
// LINE Webhook
//------------------------
app.use('/webhook', middleware(config));
app.post('/webhook', async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    return res.json(results);
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).end();
  }
});

// ============================================================
// MongoDB 版 history utils
// ============================================================
async function loadHistory(userId) {
  const coll = await getColl('history');
  const doc  = await coll.findOne({ _id: userId });
  return doc?.messages || [];
}

async function saveHistory(userId, history) {
  const coll = await getColl('history');
  await coll.updateOne(
    { _id: userId },
    { $set: { messages: history } },
    { upsert: true }
  );
}

// token 数で履歴制御
const trimByToken = (arr, maxToken = 4000) => {
  let total = 0, out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    total += [...arr[i].content].length / 4;
    if (total > maxToken) break;
    out.unshift(arr[i]);
  }
  return out;
};

// プロファイル読み込み（ファイル版）
const loadJSON = async (path, fallback) => {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch { return fallback; }
};
const saveJSON = async (path, obj) => fs.writeFile(path, JSON.stringify(obj, null, 2));

// ============================================================
// メイン Event ハンドラ
// ============================================================
async function handleEvent(event) {
  // debug
  console.log('🔍 incoming userId:', event.source.userId);
  console.log('🔍 expected motherId:', MOTHER_USER_ID);

  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userId      = event.source.userId;
  const userMessage = event.message.text.trim();
  const isMother = userId === MOTHER_USER_ID;
  const isYuto   = userId === YUTO_USER_ID;

  const motherProfile = await loadJSON(MOTHER_PROFILE_FILE, {});
  const yutoProfile   = await loadJSON(YUTO_PROFILE_FILE, {});

  // —— pending reply confirm
  if (isYuto && userMessage.toLowerCase() === 'はい') {
    const pending = await loadJSON(PENDING_REPLY_FILE, null);
    if (pending && pending.message) {
      await fs.unlink(PENDING_REPLY_FILE).catch(()=>{});
      await client.pushMessage(MOTHER_USER_ID, { type:'text', text: pending.message });
      return client.replyMessage(event.replyToken, { type:'text', text:'お母様にお伝えしました。'});
    }
  }

  // —— @report
  if (isYuto && (/^@report$/.test(userMessage) || /母の近況/.test(userMessage))) {
    const motherHist = await loadHistory(MOTHER_USER_ID);
    const recent     = motherHist.slice(-30);
    const last15     = recent.filter(m=>m.role==='user'||m.role==='assistant').slice(-15);

    const prompt = [
      { role:'system', content:'あなたはAI仲介者のWakaです。以下の会話から母の近況をやさしい口調でYutoさんに報告してください。' },
      { role:'user',   content:last15.map(m=>`${m.role==='user'?'母':'Waka'}: ${m.content}`).join('\n') }
    ];

    try {
      const summaryRes = await axios.post('https://api.openai.com/v1/chat/completions',
        { model: process.env.OPENAI_MODEL || 'gpt-4o', messages: prompt },
        { headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` }});

      const summary = summaryRes.data.choices[0].message.content;
      await client.replyMessage(event.replyToken, {
        type:'text',
        text:`【母との最近のやり取り】\n\n${last15.map(m=>`${m.role==='user'?'母':'Waka'}: ${m.content}`).join('\n')}\n\n【まとめ】\n${summary}`
      });
      return;
    } catch (err) {
      console.error('Report Error:', err.response?.data ?? err.message);
      return client.replyMessage(event.replyToken, { type:'text', text:'レポート生成に失敗しました。'});
    }
  }

  // —— 通常会話処理
  let history = await loadHistory(userId);
  history.push({ role:'user', content:userMessage });
  history = trimByToken(history);
  await saveHistory(userId, history);

  const systemPrompt = isMother ? /* mother prompt */ `あなたは「和架（Waka）」という名前のAI仲介者です。\nこのユーザーは裕智さんのお母様であることが確定しています。安心感を重視し、丁寧な口調で応答してください。` :
  `あなたは「和架（Waka）」という名前のAI仲介者です。現在、開発者（裕智）と会話しています。`;

  try {
    const messages = [ { role:'system', content:systemPrompt }, ...history ];
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions',
      { model: process.env.OPENAI_MODEL || 'gpt-4o', messages },
      { headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` }});

    const aiReply = aiRes.data.choices[0].message.content;

    if (isMother && aiReply.includes('【裕智に報告推奨】')) {
      const msgToYuto = aiReply.replace('【裕智に報告推奨】','').trim();
      await client.pushMessage(YUTO_USER_ID, { type:'text', text:`【和架からの報告】\n\n${msgToYuto}` });
    } else if (isYuto && aiReply.startsWith('【母への伝達提案】')) {
      const proposed = aiReply.replace('【母への伝達提案】','').trim();
      await saveJSON(PENDING_REPLY_FILE, { message: proposed });
      return client.replyMessage(event.replyToken, { type:'text', text:`お母様にはこのように伝えようと思います：\n\n${proposed}\n\nこの内容でよろしければ「はい」とお返事ください。` });
    }

    history.push({ role:'assistant', content: aiReply });
    history = trimByToken(history);
    await saveHistory(userId, history);

    return client.replyMessage(event.replyToken, { type:'text', text: aiReply.replace('【裕智に報告推奨】','').trim() });
  } catch (err) {
    console.error('OpenAI Error:', err.response?.data ?? err.message);
    return client.replyMessage(event.replyToken, { type:'text', text:'エラーが発生しました。'});
  }
}

// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Waka.AI Bot running on ${PORT}`);
});

// === startup ping for connection check ===
(async () => {
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.db().command({ ping: 1 });
    console.log('✅ Connected to MongoDB (startup ping)');
    await client.close();
  } catch (e) {
    console.error('🛑 MongoDB connection failed:', e.message);
  }
})();
