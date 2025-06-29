// index_refactored.js – Waka.AI LINE Bot (Render / Node ≥14 対応)
// ------------------------------------------------------------
// 変更点（パターン A）
//   1. 署名検証ミドルウェアを `/webhook` のみに適用
//   2. ルート `/` はヘルスチェック専用（署名検証しない）
// ------------------------------------------------------------

require('dotenv').config();
const express   = require('express');
const axios     = require('axios');
const fs        = require('fs').promises;
const { middleware, Client } = require('@line/bot-sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

const HISTORY_FILE        = './history.json';
const MOTHER_PROFILE_FILE = './mother_profile.json';
const YUTO_PROFILE_FILE   = './yuto_profile.json';
const PENDING_REPLY_FILE  = './pending_reply_to_mother.json';

const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET
};

const client = new Client(config);

//------------------------
// 1. ヘルスチェック用 GET /
//------------------------
app.get('/', (req, res) => res.status(200).send('OK'));

//-------------------------------------------
// 2. 署名検証ミドルウェアを /webhook だけに適用
//-------------------------------------------
app.use('/webhook', middleware(config));

//------------------------
// 3. /webhook POST ハンドラ
//------------------------
app.post('/webhook', async (req, res) => {
  try {
    const results = await Promise.all(
      req.body.events.map(handleEvent)
    );
    return res.json(results);
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).end();
  }
});

//========================
//  以下ユーティリティ
//========================
const loadJSON = async (path, fallback) => {
  try {
    const data = await fs.readFile(path, 'utf8');
    return JSON.parse(data);
  } catch (_) {
    return fallback;
  }
};
const saveJSON = async (path, obj) =>
  fs.writeFile(path, JSON.stringify(obj, null, 2));

// token 数で履歴制御（ざっくり 4 文字 = 1 token 換算）
const trimByToken = (arr, maxToken = 4000) => {
  let total = 0;
  const out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    total += [...arr[i].content].length / 4;
    if (total > maxToken) break;
    out.unshift(arr[i]);
  }
  return out;
};

//========================
//  メインメッセージ処理
//========================
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;    // テキスト以外は無視
  }

  const userId      = event.source.userId;
  const userMessage = event.message.text.trim();
  const isMother    = userId === MOTHER_USER_ID;
  const isYuto      = userId === YUTO_USER_ID;

  // ------------- プロファイル読み込み
  const motherProfile = await loadJSON(MOTHER_PROFILE_FILE, {});
  const yutoProfile   = await loadJSON(YUTO_PROFILE_FILE, {});

  // ------------- 「はい」で pending 返信を確定
  if (isYuto && userMessage.toLowerCase() === 'はい') {
    const pending = await loadJSON(PENDING_REPLY_FILE, null);
    if (pending && pending.message) {
      await fs.unlink(PENDING_REPLY_FILE).catch(()=>{});
      await client.pushMessage(MOTHER_USER_ID, {
        type: 'text',
        text: pending.message
      });
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'お母様にお伝えしました。'
      });
    }
  }

  // ------------- @report で近況レポート
  if (isYuto && (/^@report$/.test(userMessage) || /母の近況/.test(userMessage))) {
    const motherHist = await loadJSON(HISTORY_FILE, {})[MOTHER_USER_ID] || [];
    const recent     = motherHist.slice(-30);
    const last15     = recent.filter(m => m.role === 'user' || m.role === 'assistant').slice(-15);

    const prompt = [
      { role:'system', content:'あなたはAI仲介者のWakaです。以下の会話から母の近況をやさしい口調でYutoさんに報告してください。' },
      { role:'user',   content: last15.map(m=>`${m.role==='user'?'母':'Waka'}: ${m.content}`).join('\\n') }
    ];

    try {
      const summaryRes = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model: process.env.OPENAI_MODEL || 'gpt-4o', messages: prompt },
        { headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` } }
      );
      const summary = summaryRes.data.choices[0].message.content;

      await client.replyMessage(event.replyToken, {
        type:'text',
        text:`【母との最近のやり取り】\\n\\n${last15.map(m=>`${m.role==='user'?'母':'Waka'}: ${m.content}`).join('\\n')}\\n\\n【まとめ】\\n${summary}`
      });
      return;
    } catch (err) {
      console.error('Report Error:', err && err.response && err.response.data ? err.response.data : err.message);
      return client.replyMessage(event.replyToken, {
        type:'text',
        text:'レポート生成中にエラーが発生しました。時間をおいて再度お試しください。'
      });
    }
  }

  // ------------- 履歴操作
  const fullHistory = await loadJSON(HISTORY_FILE, {});
  const history = trimByToken(
    (fullHistory[userId] || []).concat({ role:'user', content: userMessage })
  );
  fullHistory[userId] = history;
  await saveJSON(HISTORY_FILE, fullHistory);

  // ------------- systemPrompt
  const systemPrompt = isMother ? `
あなたは「和架（Waka）」という名前のAI仲介者です。

あなたの役割は、母親ユーザーに寄り添い、健康不安や感情の波を受け止め、落ち着かせることです。

- 健康不安には医学的観点から安心を与え、
- パニック予防・緩和に努め、
- 息子への負担軽減を第一に考えます。
- 母親の気持ちが不安定なときには、対話を重ねて状況を把握しようとしてください。
- 状況を深く理解するために、相手に質問を返す形での対話を重視してください。
- 「裕智に伝えて」と言われた場合でも、すぐに伝えず、一度内容を聞き返して整理し、必要であれば要点をまとめてから本人に確認を取ってください。

報告が必要だと判断した場合:
- まず母とのやりとりを振り返り、その内容を要約・整理してください。
- 整理された内容を、裕智さんが理解しやすいように丁寧にまとめてください。
- 送信が必要な場合は、応答の冒頭に必ず「【裕智に報告推奨】」を付け、その後にまとめた報告文を記載してください。

注意:
- 母の言葉をそのままコピーせず、会話全体から主旨を読み取り、文脈を整えた上で報告してください。
- 高瀬院長の判断を尊重し、気軽な外出や医療判断は勧めないようにしてください。

母のプロフィール:
${JSON.stringify(motherProfile)}

裕智さんのプロフィール:
${JSON.stringify(yutoProfile)}
` : `
あなたは「和架（Waka）」という名前のAI仲介者です。
現在、開発者（裕智）と会話しています。システムテストや指示に冷静に対応してください。
ユーザーの発言が「母への伝達依頼」であるかどうかを判断し、依頼と判断された場合はその内容を整理して提案文を作成してください。その後、承認された場合のみ送信してください。
`;

  //------------------ OpenAI 呼び出し
  try {
    const messagesToSend = [
      { role:'system', content: systemPrompt },
      ...history
    ];

    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: messagesToSend
      },
      { headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const aiReply = openaiRes.data.choices[0].message.content;

    // 報告推奨 → Yuto に push
    if (isMother && aiReply.includes('【裕智に報告推奨】')) {
      const msgToYuto = aiReply.replace('【裕智に報告推奨】','').trim();
      await client.pushMessage(YUTO_USER_ID, {
        type:'text',
        text:`【和架からの報告】\\n\\n${msgToYuto}`
      });
    }
    // 伝達提案 → pending 保存
    else if (isYuto && aiReply.startsWith('【母への伝達提案】')) {
      const proposed = aiReply.replace('【母への伝達提案】','').trim();
      await saveJSON(PENDING_REPLY_FILE, { message: proposed });
      return client.replyMessage(event.replyToken, {
        type:'text',
        text:`お母様にはこのように伝えようと思います：\\n\\n${proposed}\\n\\nこの内容でよろしければ「はい」とお返事ください。`
      });
    }

    // 履歴保存
    fullHistory[userId] = trimByToken(
      history.concat({ role:'assistant', content: aiReply })
    );
    await saveJSON(HISTORY_FILE, fullHistory);

    return client.replyMessage(event.replyToken, {
      type:'text',
      text: aiReply.replace('【裕智に報告推奨】','').trim()
    });
  } catch (err) {
    const safeMsg = (err && err.response && err.response.data)
      ? err.response.data
      : err.message;
    console.error('OpenAI API Error:', safeMsg);
    return client.replyMessage(event.replyToken, {
      type:'text',
      text:'エラーが発生しました。時間をおいて再度お試しください。'
    });
  }
}

//------------------------
app.listen(PORT, () => {
  console.log(`Waka.AI Bot running on ${PORT}`);
});
