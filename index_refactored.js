// index_refactored.js – Waka.AI LINE Bot (refactored)
// 改善ポイント 4 に挙げた内容をすべて反映したバージョン
// 1) 発話履歴をトークン数で制御
// 2) OpenAI モデルを環境変数化
// 3) エラーの安全な参照
// 4) ファイル I/O を非同期 + 単純ロック
// 5) OpenAI Function Calling で報告／伝達フラグを正確検出

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { middleware, Client } = require('@line/bot-sdk');

const app = express();
const port = process.env.PORT || 3000;

// ---- 定数・ファイルパス
const HISTORY_FILE = './history.json';
const MOTHER_PROFILE_FILE = './mother_profile.json';
const YUTO_PROFILE_FILE   = './yuto_profile.json';
const PENDING_REPLY_FILE  = './pending_reply_to_mother.json';

const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

// ---- LINE SDK 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET
};
const client = new Client(config);
app.use(middleware(config));
app.use(express.json()); // body-parser

// ---- ユーティリティ
const TOKEN_LIMIT = 3000; // OpenAI 1 リクエストあたり保持する token 目安
const APPROX_CHAR_PER_TOKEN = 4; // 簡易換算
const delay = ms => new Promise(r => setTimeout(r, ms));

function approxTokens(str='') {
  return Math.ceil(str.length / APPROX_CHAR_PER_TOKEN);
}

async function withFileLock(task) {
  // 単純ミューテックス: ファイル更新時に100ms毎にリトライ
  const LOCK_FILE = '.lock';
  while (true) {
    try {
      await fs.open(LOCK_FILE, 'wx'); // lock 作成 (失敗時例外)
      break; // 取得成功
    } catch {
      await delay(100);
    }
  }
  try {
    return await task();
  } finally {
    await fs.unlink(LOCK_FILE).catch(()=>{});
  }
}

async function readJSON(path, def={}) {
  try {
    const data = await fs.readFile(path, 'utf8');
    return JSON.parse(data);
  } catch {
    return def;
  }
}
async function writeJSON(path, obj) {
  return withFileLock(() => fs.writeFile(path, JSON.stringify(obj, null, 2)));
}

// ---- 履歴管理
async function loadHistory(userId) {
  const data = await readJSON(HISTORY_FILE, {});
  return data[userId] || [];
}

async function saveHistory(userId, history) {
  const data = await readJSON(HISTORY_FILE, {});
  data[userId] = history;
  await writeJSON(HISTORY_FILE, data);
}

// ---- pending reply
async function savePendingReply(obj) {
  await writeJSON(PENDING_REPLY_FILE, obj);
}
const loadPendingReply = () => readJSON(PENDING_REPLY_FILE, null);
async function clearPendingReply() {
  try { await fs.unlink(PENDING_REPLY_FILE); } catch {}
}

// ---- OpenAI ヘルパ
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const openai = axios.create({
  baseURL: 'https://api.openai.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Function Calling Spec
const fnSpec = [
  {
    name: 'notify_yuto',
    description: 'Report important information from mother to Yuto',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Report body to send Yuto' }
      },
      required: ['summary']
    }
  },
  {
    name: 'suggest_reply_to_mother',
    description: 'Suggest a reply message from Yuto back to mother',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message text to propose' }
      },
      required: ['message']
    }
  }
];

// ---- Webhook
app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => res.json(r))
    .catch(err => {
      console.error('Webhook Error:', err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userId = event.source.userId;
  const userMessage = event.message.text.trim();

  const isMother = userId === MOTHER_USER_ID;
  const isYuto   = userId === YUTO_USER_ID;

  // ---- pending 承認
  if (isYuto && userMessage.toLowerCase() === 'はい') {
    const pending = await loadPendingReply();
    if (pending && pending.message) {
      await clearPendingReply();
      await client.pushMessage(MOTHER_USER_ID, { type: 'text', text: pending.message });
      return client.replyMessage(event.replyToken, { type: 'text', text: 'お母様にお伝えしました。' });
    }
  }

  // ---- @report コマンド
  if (isYuto && (/^@report$/.test(userMessage) || /母の近況/.test(userMessage))) {
    const motherHistory = await loadHistory(MOTHER_USER_ID);
    const recent = motherHistory.slice(-30);
    const last15 = recent.filter(m => ['user','assistant'].includes(m.role)).slice(-15);

    const prompt = [
      { role: 'system', content: 'あなたはAI仲介者のWakaです。以下の会話から母の近況をやさしい口調でYutoさんに報告してください。' },
      { role: 'user', content: last15.map(m => `${m.role === 'user' ? '母' : 'Waka'}: ${m.content}`).join('\n') }
    ];

    try {
      const { data } = await openai.post('/chat/completions', { model: OPENAI_MODEL, messages: prompt });
      const summary = data.choices[0].message.content;

      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `【母との最近のやり取り】\n\n${last15.map(m => `${m.role === 'user' ? '母' : 'Waka'}: ${m.content}`).join('\n')}\n\n【まとめ】\n${summary}`
      });
      return;
    } catch (err) {
      console.error('Report Error:', err?.response?.data ?? err.message);
      return client.replyMessage(event.replyToken, { type: 'text', text: 'レポート生成に失敗しました。時間をおいて再度お試しください。' });
    }
  }

  // ---- 通常対話
  let history = await loadHistory(userId);
  history.push({ role: 'user', content: userMessage });

  // token-based trimming
  let totalTokens = history.reduce((sum, h) => sum + approxTokens(h.content), 0);
  while (totalTokens > TOKEN_LIMIT) {
    const removed = history.shift();
    totalTokens -= approxTokens(removed.content);
  }

  // system prompt
  const motherProfile = await readJSON(MOTHER_PROFILE_FILE, {});
  const yutoProfile   = await readJSON(YUTO_PROFILE_FILE, {});

  const systemPrompt = isMother ? `あなたは「和架（Waka）」という名前のAI仲介者です。\n...（省略：同内容）...\n母のプロフィール:\n${JSON.stringify(motherProfile)}\n裕智さんのプロフィール:\n${JSON.stringify(yutoProfile)}` :
  `あなたは「和架（Waka）」という名前のAI仲介者です。現在、開発者（裕智）と会話しています...`;

  const messagesToSend = [ { role: 'system', content: systemPrompt }, ...history ];

  try {
    const { data } = await openai.post('/chat/completions', {
      model: OPENAI_MODEL,
      messages: messagesToSend,
      functions: fnSpec,
      function_call: 'auto'
    });

    const choice = data.choices[0];

    // ---- function_call 処理
    if (choice.finish_reason === 'function_call' && choice.message.function_call) {
      const { name, arguments: argsJson } = choice.message.function_call;
      const args = JSON.parse(argsJson || '{}');

      if (name === 'notify_yuto' && args.summary) {
        await client.pushMessage(YUTO_USER_ID, { type: 'text', text: `【和架からの報告】\n\n${args.summary}` });
      }
      if (name === 'suggest_reply_to_mother' && args.message && isYuto) {
        await savePendingReply({ message: args.message });
        return client.replyMessage(event.replyToken, { type: 'text', text: `お母様にはこのように伝えようと思います：\n\n${args.message}\n\nこの内容でよろしければ「はい」とお返事ください。` });
      }
    }

    // ---- 通常応答
    const aiReply = choice.message.content || '';

    history.push({ role: 'assistant', content: aiReply });
    await saveHistory(userId, history);

    return client.replyMessage(event.replyToken, { type: 'text', text: aiReply });
  } catch (error) {
    console.error('OpenAI Error:', error?.response?.data ?? error.message);
    return client.replyMessage(event.replyToken, { type: 'text', text: 'エラーが発生しました。少し時間をおいて再度お試しください。' });
  }
}

app.listen(port, () => console.log(`Waka.AI Bot running on ${port}`));
