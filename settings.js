// settings.js
const fs = require('fs-extra');
const path = require('path');
const { getconfig } = require('./mongodb');
const { MongoClient } = require('mongodb');

const uri = ''; //add ur own mongodb 
const client = new MongoClient(uri, { maxPoolSize: 10 });

let liveSettings = {};

// Load from DB and store in memory + local file
async function initEnvsettings(number) {
  const config = await getconfig(number);
  liveSettings[number] = config;

  const settingsDir = path.resolve(__dirname, 'SETTINGS');
  await fs.ensureDir(settingsDir);
  const filePath = path.join(settingsDir, `${number}.js`);
  const fileContent = `module.exports = ${JSON.stringify(config, null, 2)};\n`;
  await fs.writeFile(filePath, fileContent, 'utf8');
  delete require.cache[require.resolve(filePath)];

  return config;
}

// Get memory settings
function getSetting(number) {
  if (!liveSettings[number]) {
    console.log(`⚠️ Settings for ${number} not loaded, returning empty`);
    return {};
  }
  return liveSettings[number];
}

// Update single setting (DB + memory + local file)
async function updateSetting(number, key, value) {
  try {
    await client.connect();
    const db = client.db('ANGLEDB');
    const collection = db.collection('SETTINGS');

    const result = await collection.updateOne(
      { number },
      { $set: { [key]: value } }
    );

    if (result.matchedCount === 0) {
      console.log(`⚠️ No document found with ownerNumber ${number}`);
      return false;
    }

    // Update memory
    if (!liveSettings[number]) {
      liveSettings[number] = await getconfig(number);
    }
    liveSettings[number][key] = value;

    // Update local file
    const settingsDir = path.resolve(__dirname, 'SETTINGS');
    await fs.ensureDir(settingsDir);
    const filePath = path.join(settingsDir, `${number}.js`);
    const fileContent = `module.exports = ${JSON.stringify(liveSettings[number], null, 2)};\n`;
    await fs.writeFile(filePath, fileContent, 'utf8');
    delete require.cache[require.resolve(filePath)];

    console.log(`✅ Updated ${key} → ${value} for ${number}`);
    return true;
  } catch (err) {
    console.error(`❌ Error updating setting:`, err.message);
    return false;
  } finally {
    await client.close();
  }
}

module.exports = { initEnvsettings, getSetting,  updateSetting };
