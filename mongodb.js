// mongodb.js
const { MongoClient } = require('mongodb');

const uri = 'mongodb+srv://LordSung:Ste@dy12@suhomini.zclj5yr.mongodb.net/';
const client = new MongoClient(uri, { maxPoolSize: 10 });

const defaults = {
  AUTO_REACT: "off",
  PRESENCE_TYPE: "on",
  PRESENCE_FAKE: "both",
  ANTI_CALL: "on",
  ANTI_DELETE: "on",
  AUTO_VIEW_STATUS: "true",
  AUTO_LIKE_STATUS: "on",
  AUTO_LIKE_IMOJI: "❤️",
};

// Ensure user doc exists
async function initUserEnvIfMissing(number) {
  try {
    await client.connect();
    const db = client.db('STARDB');
    const collection = db.collection('SETTINGS');

    const doc = await collection.findOne({ number });
    if (!doc) {
      await collection.updateOne(
        { number },
        { $set: { number, ...defaults } },
        { upsert: true }
      );
      console.log(`✅ Created defaults for ${number}`);
      return { number, ...defaults };
    }
    return doc;
  } catch (err) {
    console.error("❌ initUserEnvIfMissing error:", err.message);
    return { number, ...defaults };
  } finally {
    await client.close();
  }
}

// Get config from DB
async function getconfig(number) {
  try {
    await client.connect();
    const db = client.db('STARDB');
    const collection = db.collection('SETTINGS');
    const doc = await collection.findOne({ number });
    return doc || { number, ...defaults };
  } catch (err) {
    console.error("❌ getconfig error:", err.message);
    return { number, ...defaults };
  } finally {
    await client.close();
  }
}

module.exports = { initUserEnvIfMissing, getconfig };
