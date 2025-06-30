// index_refactored.js – Waka.AI LINE Bot (MongoDB persistent version)
// ------------------------------------------------------------
// Features
//  1. Health Check at '/'
//  2. MongoDB Atlas for history, profile, pending collections
//  3. Async I/O, token‑based history trim
//  4. Startup ping to verify DB connection
// ------------------------------------------------------------

require('dotenv').config();
const express   = require('express');
const axios     = require('axios');
const { middleware, Client } = require('@line/bot-sdk');
const { getColl } = require('./db');           // Mongo helper

const app  = express();
const PORT = process.env.PORT || 3000;

// User IDs ----------------------------------------------------
const MOTHER_USER_ID = 'Ubad10f224134c8f26da25d59730c0b5d';
const YUTO_USER_ID   = 'U6f600038828ff8d3257b52a5d6c17284';

// LINE config -------------------------------------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET
};
const client = new Client(config);

// Health Check ------------------------------------------------
app.get('/', (req,res)=>res.status(200).send('OK'));
app.use('/webhook', middleware(config));
app.post('/webhook', async (req,res)=>{
  try {
    const out = await Promise.all(req.body.events.map(handleEvent));
    res.json(out);
  } catch(e){ console.error('Webhook',e); res.status(500).end(); }
});

// ---------- Mongo helpers -----------------------------------
async function loadHistory(uid){
  const c = await getColl('history');
  const d = await c.findOne({_id:uid});
  return d?.messages||[];
}
async function saveHistory(uid, arr){
  const c = await getColl('history');
  await c.updateOne({_id:uid},{ $set:{messages:arr} },{ upsert:true });
}
async function loadProfile(uid){
  const c = await getColl('profile');
  const d = await c.findOne({_id:uid});
  return d||{};
}
async function saveProfile(uid,obj){
  const c = await getColl('profile');
  await c.updateOne({_id:uid},{ $set:obj },{ upsert:true });
}
async function loadPending(){
  const c = await getColl('pending');
  return (await c.findOne({_id:'pending'}))?.data||null;
}
async function savePending(data){
  const c = await getColl('pending');
  await c.updateOne({_id:'pending'},{ $set:{data} },{ upsert:true });
}
async function clearPending(){ await savePending(null); }

// ---------- util --------------------------------------------
const trimByToken = (arr, max=4000)=>{
  let tot=0, out=[]; for(let i=arr.length-1;i>=0;i--){
    tot += [...arr[i].content].length/4; if(tot>max) break; out.unshift(arr[i]); }
  return out; };

// ---------- main handler ------------------------------------
async function handleEvent(event){
  if(event.type!=='message'||event.message.type!=='text') return null;
  const uid=event.source.userId; const msg=event.message.text.trim();
  const isMother=uid===MOTHER_USER_ID; const isYuto=uid===YUTO_USER_ID;

  // log ids
  console.log('🔍 incoming',uid,' isMother',isMother);

  // load profile / init
  const motherProfile = await loadProfile(MOTHER_USER_ID);
  const yutoProfile   = await loadProfile(YUTO_USER_ID);
  if(!motherProfile.name){ await saveProfile(MOTHER_USER_ID,{name:'お母様',tone:'やさしい敬語'}); motherProfile.name='お母様'; }
  if(!yutoProfile.name){ await saveProfile(YUTO_USER_ID,{name:'裕智さん'}); }

  // "はい" for pending
  if(isYuto && msg.toLowerCase()==='はい'){
    const p=await loadPending();
    if(p){await clearPending(); await client.pushMessage(MOTHER_USER_ID,{type:'text',text:p});
      return client.replyMessage(event.replyToken,{type:'text',text:'お母様にお伝えしました。'}); }
  }

  // @report
  if(isYuto && (/^@report$/.test(msg)||/母の近況/.test(msg))){
    const mHist=await loadHistory(MOTHER_USER_ID); const recent=mHist.slice(-30);
    const last15=recent.filter(m=>m.role==='user'||m.role==='assistant').slice(-15);
    const prompt=[{role:'system',content:'あなたはAI仲介者Wakaです。以下の会話から母の近況をやさしい口調でYutoさんに報告してください。'},{role:'user',content:last15.map(m=>`${m.role==='user'?'母':'Waka'}: ${m.content}`).join('\n')}];
    try{
      const r=await axios.post('https://api.openai.com/v1/chat/completions',{model:process.env.OPENAI_MODEL||'gpt-4o',messages:prompt},{headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`}});
      const sum=r.data.choices[0].message.content;
      await client.replyMessage(event.replyToken,{type:'text',text:`【母との最近のやり取り】\n\n${last15.map(m=>`${m.role==='user'?'母':'Waka'}: ${m.content}`).join('\n')}\n\n【まとめ】\n${sum}`});
      return; }catch(e){ console.error('report',e.message); return client.replyMessage(event.replyToken,{type:'text',text:'レポート生成エラー'});} }

  // history
  const hist=trimByToken((await loadHistory(uid)).concat({role:'user',content:msg}));
  await saveHistory(uid,hist);

  const systemPrompt = isMother ? `あなたは和架です。このユーザーはお母様で確定。${motherProfile.tone||'やさしい敬語'}で対応してください。` : `あなたは和架です。開発者モード。`;

  try{
    const res=await axios.post('https://api.openai.com/v1/chat/completions',{model:process.env.OPENAI_MODEL||'gpt-4o',messages:[{role:'system',content:systemPrompt},...hist]},{headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`}});
    const aiReply=res.data.choices[0].message.content;
    // pending / report logic simplified
    await client.replyMessage(event.replyToken,{type:'text',text:aiReply});
    await saveHistory(uid,trimByToken(hist.concat({role:'assistant',content:aiReply})));
  }catch(err){ console.error('OpenAI',err.message); await client.replyMessage(event.replyToken,{type:'text',text:'エラーが発生しました。'}); }
}

// ---------- startup ping ------------------------------------
(async()=>{try{const { MongoClient }=require('mongodb');const c=new MongoClient(process.env.MONGODB_URI);await c.db().command({ping:1});console.log('✅ Connected to MongoDB (startup ping)');await c.close();}catch(e){console.error('🛑 MongoDB connection failed:',e.message);}})();

// ------------------------------------------------------------
app.listen(PORT,()=>console.log('Waka.AI Bot running on',PORT));

