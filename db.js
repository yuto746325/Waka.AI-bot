// db.js ─ MongoDB helper（同じ。触っていなければそのままでOK）
const { MongoClient } = require('mongodb');
const uri    = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'waka_ai';
const client = new MongoClient(uri, { maxPoolSize: 5 });

async function getColl(name) {
  if (!client.topology) await client.connect();
  return client.db(dbName).collection(name);
}
module.exports = { getColl };
