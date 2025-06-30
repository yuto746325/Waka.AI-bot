/* index_refactored.js ─ Waka.AI (報告フロー強化版)
   - MongoDB永続化: history / profile / pending
   - Function calling “decide_report” で報告要否と議論フラグをJSON受取
   - Yuto と議論 → 「はい」で母へPush
*/

require('dotenv').config();
const express = require('express');
const axios    = require('axios');
const axiosRetry = require('axios-retry');
const { middleware, Client } = require('@line/bot-sdk');
const { getColl } = require('./db');

//────────────────────────────────────────────
// 基本設定
//────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// OpenAI retry設定
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: err => !!err.response && [429,500,502,503].includes(err.response.status)
});

//────────────────────────────────────────────
// ヘルスチェック & DB ping
//────────────────────────────────────────────
app.get('/', (_, res) => res.status(200).send('OK'));
(async ()=>{
  try {
    const { MongoClient } = require('mongodb');
    const c = new MongoClient(process.env.MONGODB_URI);
    await c.db().command({ ping:1 });
    console.log('✅ Connected to MongoDB (startup ping)');
    await c.close();
  } catch(e){ console.error('🛑 Mongo ping failed:', e.message); }
})();

//────────────────────────────────────────────
// Mongoユーティリティ
//────────────────────────────────────────────
const loadCollDoc = async (coll, id) => (await getColl(coll)).findOne({ _id:id }) || {};
const saveCollDoc = async (coll, id, doc) =>
  (await getColl(coll)).updateOne({ _id:id },{$set:doc},{upsert:true});

// history
const loadHistory = id  => loadCollDoc('history',  id).then(d=>d.messages||[]);
const saveHistory = (id,h)=>saveCollDoc('history', id,{messages:h});

// profile
const loadProfile = id  => loadCollDoc('profile',  id);
const saveProfile = (id,p)=>saveCollDoc('profile', id,p);

// pending（母への伝達案を一時保管）
const loadPending = ()   => loadCollDoc('pending','mother');
const savePending = doc  => saveCollDoc('pending','mother',doc);
const clearPending= ()   => (getColl('pending')).deleteOne({_id:'mother'});

// 履歴トリム
const trimByToken=(arr,limit=4000)=>{let s=0,o=[];for(let i=arr.length-1;i>=0;i--){s+=[...arr[i].content].length/4;if(s>limit)break;o.unshift(arr[i]);}return o;};

//────────────────────────────────────────────
// LINE Webhook
//────────────────────────────────────────────
app.use('/webhook', middleware(lineConfig));
app.post('/webhook', async (req,res)=>{
  try{
    const r = await Promise.all(req.body.events.map(handleEvent));
    res.json(r);
  }catch(e){console.error('WebhookErr',e);res.status(500).end();}
});

//────────────────────────────────────────────
// handleEvent
//────────────────────────────────────────────
async function handleEvent(event){
  if(event.type!=='message'||event.message.type!=='text')return;
  const userId=event.source.userId;
  const text  =event.message.text.trim();
  const isMother=userId===MOTHER_USER_ID;
  const isYuto  =userId===YUTO_USER_ID;

  // プロフィール読み込み
  const motherProfile=await loadProfile(MOTHER_USER_ID);
  const yutoProfile  =await loadProfile(YUTO_USER_ID);
  if(!motherProfile.name){Object.assign(motherProfile,{name:'裕智の母',tone:'やさしい敬語'});await saveProfile(MOTHER_USER_ID,motherProfile);}
  if(!yutoProfile.name){Object.assign(yutoProfile,{name:'裕智',tone:'冷静で思いやりある敬語'});await saveProfile(YUTO_USER_ID,yutoProfile);}

  // 管理コマンドでプロフィール上書き
  if(isYuto && text.startsWith('@setMotherProfile')){
    return respondJsonUpdate(text,'@setMotherProfile',MOTHER_USER_ID,event.replyToken);
  }
  if(isYuto && text.startsWith('@setYutoProfile')){
    return respondJsonUpdate(text,'@setYutoProfile',YUTO_USER_ID,event.replyToken);
  }

  // Yuto 承認「はい」
  if(isYuto && text.toLowerCase()==='はい'){
    const pending=await loadPending();
    if(pending?.message){
      await client.pushMessage(MOTHER_USER_ID,{type:'text',text:pending.message});
      await clearPending();
      return client.replyMessage(event.replyToken,{type:'text',text:'お母様にお伝えしました。'});
    }
  }

  // ------------------------------------------------
  // 通常 / 報告フロー
  // ------------------------------------------------
  let history=await loadHistory(userId);
  history.push({role:'user',content:text});
  history=trimByToken(history);
  await saveHistory(userId,history);

  const systemPrompt=isMother?`
あなたは「和架（Waka）」というAI仲介者です。
このユーザーは裕智さんのお母様（本人確認不要）です。
母プロフィール:
${JSON.stringify(motherProfile)}
裕智プロフィール:
${JSON.stringify(yutoProfile)}
`:`
あなたは「和架（Waka）」というAI仲介者です。
現在、開発者（${yutoProfile.name}）と会話しています。
開発者プロフィール:
${JSON.stringify(yutoProfile)}
`;

  const messages=[{role:'system',content:systemPrompt},...history];

  // -------- Mother → 判定用 function calling -----------
  if(isMother){
    const functions=[{
      name:'decide_report',
      parameters:{
        type:'object',
        properties:{
          reportToYuto:{type:'string'},
          discussWithYuto:{type:'boolean'}
        },
        required:['reportToYuto','discussWithYuto']
      }
    }];
    const rsp=await openaiCall(messages,functions,{name:'decide_report'});
    const args=JSON.parse(rsp.message.function_call.arguments);
    const {reportToYuto,discussWithYuto}=args;

    let aiReply=reportToYuto;  // Waka が母へ返す通常応答も返却文に入れておく想定
    if(discoverAssistantReply(rsp)) aiReply=rsp.message.content; // fallback: content欄

    // 1) reportToYuto が空 → 何もしない
    if(!reportToYuto){
      await replyAndSave(aiReply,event.replyToken,history,userId);
      return;
    }

    // 2) discuss false → 直接裕智へ
    if(!discussWithYuto){
      await client.pushMessage(YUTO_USER_ID,{type:'text',text:`【和架から自動報告】\n\n${reportToYuto}`});
      await replyAndSave(aiReply,event.replyToken,history,userId);
      return;
    }

    // 3) discuss true → pending に保存し、裕智へ提案
    await savePending({message:reportToYuto});
    await client.pushMessage(YUTO_USER_ID,{
      type:'text',
      text:`【報告案】\n\n${reportToYuto}\n\n修正があればメッセージで送ってください。\nそのまま送る場合は「はい」と返信してください。`
    });
    await replyAndSave(aiReply,event.replyToken,history,userId);
    return;
  }

  // -------- Yuto またはその他ユーザー --------
  const rsp=await openaiCall(messages);
  const aiReply=rsp.message.content;
  await replyAndSave(aiReply,event.replyToken,history,userId);
}

//────────────────────────────────────────────
// ユーティリティ関数
//────────────────────────────────────────────
async function openaiCall(messages,functions=null,function_call=null){
  const payload={model:process.env.OPENAI_MODEL||'gpt-4o',messages};
  if(functions)      payload.functions=functions;
  if(function_call)  payload.function_call=function_call;
  return (await axios.post('https://api.openai.com/v1/chat/completions',
            payload,{headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`} } )
         ).data.choices[0];
}

function discoverAssistantReply(choice){
  return choice.message?.content;
}

async function replyAndSave(aiReply,replyToken,history,userId){
  await client.replyMessage(replyToken,{type:'text',text:aiReply});
  history.push({role:'assistant',content:aiReply});
  history=trimByToken(history);
  await saveHistory(userId,history);
}

async function respondJsonUpdate(text,cmd,userId,replyToken){
  try{
    const obj=JSON.parse(text.replace(cmd,'').trim());
    await saveProfile(userId,obj);
    return client.replyMessage(replyToken,{type:'text',text:'プロフィールを更新しました ✅'});
  }catch{ return client.replyMessage(replyToken,{type:'text',text:'JSON が不正です ❌'}); }
}

//────────────────────────────────────────────
app.listen(PORT,()=>console.log(`Waka.AI Bot running on ${PORT}`));
