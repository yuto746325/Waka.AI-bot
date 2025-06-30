/**
 * index_refactored.js – Waka.AI LINE Bot
 *  - MongoDB Atlas で history / profile / pending を永続化
 *  - 母アカウントは「本人確認を求めない」よう systemPrompt を修正
 *  - Health Check ‘/’ で Render Free のスリープ復帰対策
 *  - Startup ping で DB 接続を確認（ログに ✅ 表示）
 */

require('dotenv').config();
const express = require('express');
const axios    = require('axios');
const { middleware, Client } = require('@line/bot-sdk');
const { getColl } = require('./db');          // MongoDB helper

//------------------------------------------------------------------
// LINE & Express 基本設定
//------------------------------------------------------------------
const app  = express();
const PORT = process.env.PORT || 3000;

const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);

//------------------------------------------------------------------
// MongoDB 用ユーティリティ
//------------------------------------------------------------------
async function loadHistory(userId) {
  const c = await getColl('history');
  const doc = await c.findOne({ _id: userId });
  return doc?.messages || [];
}
async function saveHistory(userId, history) {
  const c = await getColl('history');
  await c.updateOne(
    { _id: userId },
    { $set: { messages: history } },
    { upsert: true }
  );
}
async function loadProfile(userId) {
  const c = await getColl('profile');
  const doc = await c.findOne({ _id: userId });
  return doc || {};
}
async function saveProfile(userId, obj) {
  const c = await getColl('profile');
  await c.updateOne(
    { _id: userId },
    { $set: obj },
    { upsert: true }
  );
}

//------------------------------------------------------------------
// ヘルスチェック & 起動時 DB ping
//------------------------------------------------------------------
app.get('/', (req, res) => res.status(200).send('OK'));

(async () => {
  try {
    const { MongoClient } = require('mongodb');
    const test = new MongoClient(process.env.MONGODB_URI);
    await test.db().command({ ping: 1 });
    console.log('✅ Connected to MongoDB (startup ping)');
    await test.close();
  } catch (e) {
    console.error('🛑 Mongo ping failed:', e.message);
  }
})();

//------------------------------------------------------------------
// LINE Webhook
//------------------------------------------------------------------
app.use('/webhook', middleware(lineConfig));

app.post('/webhook', async (req, res) => {
  try {
    const result = await Promise.all(req.body.events.map(handleEvent));
    res.json(result);
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).end();
  }
});

//------------------------------------------------------------------
// 会話履歴トリム（ざっくり 4 文字=1token 計算）
//------------------------------------------------------------------
function trimByToken(arr, limit = 4000) {
  let sum = 0;
  const out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    sum += [...arr[i].content].length / 4;
    if (sum > limit) break;
    out.unshift(arr[i]);
  }
  return out;
}

//------------------------------------------------------------------
// メイン処理
//------------------------------------------------------------------
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const text   = event.message.text.trim();

  // デバッグ: userId
  // console.log('userId:', userId);

  const isMother = userId === MOTHER_USER_ID;
  const isYuto   = userId === YUTO_USER_ID;

  // ----------- プロフィール読み込み（初回なら作成）
  const motherProfile = await loadProfile(MOTHER_USER_ID);
  const yutoProfile   = await loadProfile(YUTO_USER_ID);
  if (!motherProfile.name) {
    Object.assign(motherProfile, { name: '裕智の母', tone: 'やさしい敬語' });
    await saveProfile(MOTHER_USER_ID, motherProfile);
  }
  if (!yutoProfile.name) {
    Object.assign(yutoProfile, { name: '裕智', tone: '冷静で思いやりある敬語' });
    await saveProfile(YUTO_USER_ID, yutoProfile);
  }

  // ----------- 管理コマンド: プロフィール手動更新
  if (isYuto && text.startsWith('@setMotherProfile')) {
    try {
      const obj = JSON.parse(text.replace('@setMotherProfile', '').trim());
      await saveProfile(MOTHER_USER_ID, obj);
      return client.replyMessage(event.replyToken, { type:'text', text:'母プロフィールを更新しました ✅'});
    } catch {
      return client.replyMessage(event.replyToken, { type:'text', text:'JSON 形式が正しくありません ❌'});
    }
  }
  if (isYuto && text.startsWith('@setYutoProfile')) {
    try {
      const obj = JSON.parse(text.replace('@setYutoProfile', '').trim());
      await saveProfile(YUTO_USER_ID, obj);
      return client.replyMessage(event.replyToken, { type:'text', text:'自身のプロフィールを更新しました ✅'});
    } catch {
      return client.replyMessage(event.replyToken, { type:'text', text:'JSON 形式が正しくありません ❌'});
    }
  }

  // ----------- 履歴読み書き
  let history = await loadHistory(userId);
  history.push({ role:'user', content: text });
  history = trimByToken(history);
  await saveHistory(userId, history);

  // ----------- systemPrompt
  const systemPrompt = isMother ? `
あなたは「和架（Waka）」という名前のAI仲介者です。
**このユーザーは裕智さんのお母様であることが確定しています。本人確認は不要です。**
母親ユーザーに寄り添い、健康不安や感情の波を受け止め、落ち着かせることが役割です。
母のプロフィール:
${JSON.stringify(motherProfile)}
裕智さんのプロフィール:
${JSON.stringify(yutoProfile)}
` : `
あなたは「和架（Waka）」という名前のAI仲介者です。
現在、開発者（${yutoProfile.name}）と会話しています。指示に冷静に対応してください。
`;

  // ----------- OpenAI 呼び出し
  const messages = [{ role:'system', content: systemPrompt }, ...history];

  try {
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages
      },
      { headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    const aiReply = openaiRes.data.choices[0].message.content;

    // 履歴保存
    history.push({ role:'assistant', content: aiReply });
    history = trimByToken(history);
    await saveHistory(userId, history);

    return client.replyMessage(event.replyToken, { type:'text', text: aiReply });
  } catch (e) {
    console.error('OpenAI error:', e.response?.data || e.message);
    return client.replyMessage(event.replyToken, { type:'text', text:'少し時間を置いて再度お試しください。' });
  }
}

//------------------------------------------------------------------
app.listen(PORT, () => console.log(`Waka.AI Bot running on ${PORT}`));
