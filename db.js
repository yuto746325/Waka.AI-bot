// db.js  --- MongoDB helper
const { MongoClient } = require('mongodb');

const uri    = process.env.MONGODB_URI;          // Render の環境変数
const dbName = process.env.MONGODB_DB || 'waka_ai';

const client = new MongoClient(uri, { maxPoolSize: 5 });

async function getColl(name) {
  // まだ接続していなければここで接続
  if (!client.topology) await client.connect();
  return client.db(dbName).collection(name);
}

module.exports = { getColl };
