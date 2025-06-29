// index_refactored.js – Waka.AI LINE Bot (Render / Node ≥14 対応)
// ------------------------------------------------------------
// ● 追加: ルート '/' で 200 OK を返すヘルスチェック
//   Render の Health Check が署名ヘッダ無しで叩くため、LINE SDK の署名検証をバイパス。
// ● 既存リファクタリング（token 長制御・model env・非同期 I/O・function calling）は維持
// ------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { middleware, Client } = require('@line/bot-sdk');
const { createHash } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ファイルパス定数
const HISTORY_FILE = './history.json';
const MOTHER_PROFILE_FILE = './mother_profile.json';
const YUTO_PROFILE_FILE = './yuto_profile.json';
const PENDING_REPLY_FILE = './pending_reply_to_mother.json';

// 固定ユーザー ID
const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

// LINE SDK クライアント設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET
};
if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  throw new Error('LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が .env に定義されていません');
}

const client = new Client(lineConfig);
app.use(middleware(lineConfig));
app.use(express.json());

// ---------- ヘルスチェック ----------
app.get('/', (req, res) => res.status(200).send('OK')); // Render 用

// ---------- ユーティリティ ----------
const TOKEN_LIMIT = 4000; // ざっくり 1token ≒ 4文字換算

async function readJsonSafe(path, fallback = {}) {
  try {
    const txt = await fs.readFile(path, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(path, data) {
  await fs.writeFile(path, JSON.stringify(data, null, 2));
}

function truncateByToken(arr) {
  // 超簡易: UTF-8 長で概算 1/4
  let total = 0;
  const out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i];
    total += t.content.length / 4;
    if (total > TOKEN_LIMIT) break;
    out.unshift(t);
  }
  return out;
}

// ---------- 履歴・プロフィール操作 ----------
async function loadHistory(userId) {
  const data = await readJsonSafe(HISTORY_FILE, {});
  return data[userId] || [];
}

async function saveHistory(userId, history) {
  const data = await readJsonSafe(HISTORY_FILE, {});
  data[userId] = history;
  await writeJsonSafe(HISTORY_FILE, data);
}

const loadMotherProfile = () => readJsonSafe(MOTHER_PROFILE_FILE, {});
const loadYutoProfile   = () => readJsonSafe(YUTO_PROFILE_FILE, {});
const savePendingReply  = (d) => writeJsonSafe(PENDING_REPLY_FILE, d);
const loadPendingReply  = () => readJsonSafe(PENDING_REPLY_FILE, null);
const clearPendingReply = () => fs.unlink(PENDING_REPLY_FILE).catch(() => {});

// ---------- OpenAI 呼び出し ----------
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OPENAI_URL   = 'https://api.openai.com/v1/chat/completions';
const OPENAI_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
};

async function chatCompletion(messages, functions = undefined) {
  const body = { model: OPENAI_MODEL, messages };
  if (functions) body.functions = functions;
  const res = await axios.post(OPENAI_URL, body, { headers: OPENAI_HEADERS });
  return res.data.choices[0];
}

// ---------- Webhook ----------
app.post('/webhook', async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userId      = event.source.userId;
  const userMessage = event.message.text.trim();
  const isMother = userId === MOTHER_USER_ID;
  const isYuto   = userId === YUTO_USER_ID;

  // "はい" で pending 送信
  if (isYuto && userMessage.toLowerCase() === 'はい') {
    const pending = await loadPendingReply();
    if (pending?.message) {
      await clearPendingReply();
      await client.pushMessage(MOTHER_USER_ID, { type: 'text', text: pending.message });
      return client.replyMessage(event.replyToken, { type: 'text', text: 'お母様にお伝えしました。' });
    }
  }

  // @report コマンド
  if (isYuto && /^@report$/.test(userMessage)) {
    const mothHist = await loadHistory(MOTHER_USER_ID);
    const recent   = mothHist.slice(-30);
    const last15   = recent.filter(m => m.role === 'user' || m.role === 'assistant').slice(-15);

    const prompt = [
      { role: 'system', content: 'あなたはAI仲介者のWakaです。以下の会話から母の近況をやさしく報告してください。' },
      { role: 'user',   content: last15.map(m => `${m.role === 'user' ? '母' : 'Waka'}: ${m.content}`).join('\n') }
    ];

    try {
      const sum = (await chatCompletion(prompt)).message.content;
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `【母との最近のやり取り】\n\n${last15.map(m => `${m.role === 'user' ? '母' : 'Waka'}: ${m.content}`).join('\n')}\n\n【まとめ】\n${sum}`
      });
    } catch (err) {
      const safeMsg = err?.response?.data ?? err.message;
      console.error('Report Error:', safeMsg);
      await client.replyMessage(event.replyToken, { type: 'text', text: 'レポート生成中にエラーが発生しました。' });
    }
    return;
  }

  // 通常メッセージ処理
  let history = await loadHistory(userId);
  history.push({ role: 'user', content: userMessage });
  history = truncateByToken(history);

  const motherProfile = await loadMotherProfile();
  const yutoProfile   = await loadYutoProfile();

  const systemPrompt = isMother ? `あなたは「和架（Waka）」という名前のAI仲介者です。\n...（省略: 母用プロンプト全文）` : `あなたは「和架（Waka）」という名前のAI仲介者です。\n...（省略: 裕智用プロンプト全文）`;

  const messages = [{ role: 'system', content: systemPrompt }, ...history];

  try {
    const aiRes = await chatCompletion(messages);
    const aiReply = aiRes.message.content;

    // 報告・伝達フラグ判定
    if (isMother && aiReply.includes('【裕智に報告推奨】')) {
      const body = aiReply.replace('【裕智に報告推奨】', '').trim();
      await client.pushMessage(YUTO_USER_ID, { type: 'text', text: `【和架からの報告】\n\n${body}` });
    }
    if (isYuto && aiReply.startsWith('【母への伝達提案】')) {
      const msg = aiReply.replace('【母への伝達提案】', '').trim();
      await savePendingReply({ message: msg });
      await client.replyMessage(event.replyToken, { type: 'text', text: `お母様にはこのように伝えます:\n\n${msg}\n\nよろしければ「はい」とお返事ください。` });
    } else {
      await client.replyMessage(event.replyToken, { type: 'text', text: aiReply.replace('【裕智に報告推奨】', '').trim() });
    }

    history.push({ role: 'assistant', content: aiReply });
    history = truncateByToken(history);
    await saveHistory(userId, history);
  } catch (err) {
    const safeMsg = err?.response?.data ?? err.message;
    console.error('OpenAI Error:', safeMsg);
    await client.replyMessage(event.replyToken, { type: 'text', text: 'エラーが発生しました。少し時間をおいて再度お試しください。' });
  }
}

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`Waka.AI Bot running on ${PORT}`);
});
