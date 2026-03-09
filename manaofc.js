const axios = require('axios');
const yts = require('yt-search');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const os = require('os');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const { File } = require('megajs');
const apkdl = require('./lib/apkdl');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const cheerio = require('cheerio');
const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson, getsize, formatBytes, fetchBuffer, formatSize, getFile } = require('./lib/functions');

const {
  default: makeWASocket,
  getAggregateVotesInPollMessage,
  useMultiFileAuthState,
  DisconnectReason,
  getDevice,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  getContentType,
  Browsers,
  makeInMemoryStore,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  generateForwardMessageContent,
  proto,
  delay
} = require('baileys');


// Default config structure
const defaultConfig = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    WORK_TYPE: 'private',
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: 'https://i.ibb.co/S4Cf2kZg/IMG-0773.png',
    OWNER_NUMBER: '94759934522'
};

// GitHub Octokit initialization
let octokit;
if (process.env.GITHUB_TOKEN) {
    octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN
    });
}
const owner = process.env.GITHUB_REPO_OWNER;
const repo = process.env.GITHUB_REPO_NAME;

// Memory optimization: Use weak references for sockets
const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

// Memory optimization: Cache frequently used data
let adminCache = null;
let adminCacheTime = 0;
const ADMIN_CACHE_TTL = 300000; // 5 minutes

// Initialize directories
if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// Memory optimization: Improved admin loading with caching
function loadAdmins() {
    try {
        const now = Date.now();
        if (adminCache && now - adminCacheTime < ADMIN_CACHE_TTL) {
            return adminCache;
        }
        
        if (fs.existsSync(defaultConfig.ADMIN_LIST_PATH)) {
            adminCache = JSON.parse(fs.readFileSync(defaultConfig.ADMIN_LIST_PATH, 'utf8'));
            adminCacheTime = now;
            return adminCache;
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

// Memory optimization: Use template literals efficiently
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// Memory optimization: Clean up unused variables and optimize loops
async function cleanDuplicateFiles(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`creds_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        // Keep only the first (newest) file, delete the rest
        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Memory optimization: Reduce memory usage in message sending
async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage(
        'Bot Connected',
        `📞 Number: ${number}\nBots: Connected`,
        ' _*Powered By Manaofc*_'
    );

    // Send messages sequentially to avoid memory spikes
    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: defaultConfig.IMAGE_PATH },
                    caption
                }
            );
            // Add a small delay to prevent rate limiting and memory buildup
            await delay(100);
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}


// Memory optimization: Throttle status handlers
function setupStatusHandlers(socket, userConfig) {
    let lastStatusInteraction = 0;
    const STATUS_INTERACTION_COOLDOWN = 10000; // 10 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
        
        // Throttle status interactions to prevent spam
        const now = Date.now();
        if (now - lastStatusInteraction < STATUS_INTERACTION_COOLDOWN) {
            return;
        }

        try {
            if (userConfig.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (userConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }

            if (userConfig.AUTO_LIKE_STATUS === 'true') {
                const emojis = Array.isArray(userConfig.AUTO_LIKE_EMOJI) ? 
                    userConfig.AUTO_LIKE_EMOJI : defaultConfig.AUTO_LIKE_EMOJI;
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        lastStatusInteraction = now;
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function downloadAndSaveMedia(message, mediaType) {
    try {
        const stream = await downloadContentFromMessage(message, mediaType);
        let buffer = Buffer.from([]);

        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        return buffer;
    } catch (error) {
        //console.error('Download Media Error:', error);
        throw error;
    }
}
// Setup command handlers for a single socket/session
function setupCommandHandlers(socket, number, userConfig) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user

    // Command registry
    const commands = [];

    function cmd(info, func) {
        info.function = func;
        if (!info.desc) info.desc = "";
        if (!info.category) info.category = "misc";
        if (!info.filename) info.filename = "Not Provided";
        if (!info.fromMe) info.fromMe = false;
        if (!info.dontAddCommandList) info.dontAddCommandList = false;
        commands.push(info);
        return info;
    }

  //====================
  const cos = '```';
    const basePath = path.join(__dirname, "database");
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath);

    function ensureFolder(folder) {
        const folderPath = path.join(basePath, folder);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
    }

    function readJSON(folder, file, defaultData = []) {
        ensureFolder(folder);
        const filePath = path.join(basePath, folder, file);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
            return defaultData;
        }
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    function writeJSON(folder, file, data) {
        ensureFolder(folder);
        const filePath = path.join(basePath, folder, file);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    // ---------------- CMD STORE ----------------
    async function updateCMDStore(MsgID, CmdID) {
        try {
            let olds = readJSON("Non-Btn", "data.json", []);
            olds.push({ [MsgID]: CmdID });
            writeJSON("Non-Btn", "data.json", olds);
            return true;
        } catch (e) {
            console.log(e);
            return false;
        }
    }

    async function isbtnID(MsgID) {
        try {
            let olds = readJSON("Non-Btn", "data.json", []);
            return olds.some((item) => item[MsgID]);
        } catch {
            return false;
        }
    }

    async function getCMDStore(MsgID) {
        try {
            let olds = readJSON("Non-Btn", "data.json", []);
            for (const item of olds) {
                if (item[MsgID]) return item[MsgID];
            }
            return null;
        } catch (e) {
            console.log(e);
            return null;
        }
    }

    function getCmdForCmdId(CMD_ID_MAP, cmdId) {
        const result = CMD_ID_MAP.find((entry) => entry.cmdId === cmdId);
        return result ? result.cmd : null;
    }
// ---------------- BUTTON MESSAGE -----------------

const NON_BUTTON = true; // Implement a switch to on/off this feature...

socket.buttonMessage = async (jid, msgData, quotemek) => {

if (!NON_BUTTON) {
          await conn.sendMessage(jid, msgData);
        } else {

let result = "";
const CMD_ID_MAP = [];

msgData.buttons.forEach((button, bttnIndex) => {

const mainNumber = `${bttnIndex + 1}`;

result += `\n◈ *${mainNumber} - ${button.buttonText.displayText}*`;

CMD_ID_MAP.push({
cmdId: mainNumber,
cmd: button.buttonId
});

});

const buttonMessage = `

${msgData.caption || msgData.text}

*╭─────────────────❥➻*
*╎*  ${cos}🔢 Reply Below Number:${cos}
*╰─────────────────❥➻*

${result}

${msgData.footer || ""}
`;

const btnimg = msgData.image
? { url: msgData.image }
: { url: defaultConfig.IMAGE_PATH };

const imgmsg = await socket.sendMessage(
jid,
{ image: btnimg, caption: buttonMessage },
{ quoted: quotemek }
);

await updateCMDStore(imgmsg.key.id, CMD_ID_MAP);
}
};


// ---------------- LIST MESSAGE -----------------
      socket.listMessage = async (jid, msgData, quotemek) => {
        if (!NON_BUTTON) {
          await socket.sendMessage(jid, msgData);
        } else {
          let result = "";
          const CMD_ID_MAP = [];

          msgData.sections.forEach((section, sectionIndex) => {
            const mainNumber = `${sectionIndex + 1}`;
            result += `\n*${mainNumber} :* ${section.title}\n`;

            section.rows.forEach((row, rowIndex) => {
              const subNumber = `${mainNumber}.${rowIndex + 1}`;
              const rowHeader = `◦  ${subNumber} - ${row.title}`;
              result += `${rowHeader}\n`;
              CMD_ID_MAP.push({ cmdId: subNumber, cmd: row.rowId });
            });
          });

          const listimg = msgData.image
            ? { url: msgData.image }
            : { url: defaultConfig.IMAGE_PATH };

          const listMessage = `
${msgData.text}

*╭─────────────────❥➻*
*╎*  ${cos}🔢 Reply Below Number:${cos}
*╰─────────────────❥➻*

${result}

${msgData.footer}`;

          const text = await socket.sendMessage(
            jid,
            { image: listimg, caption: listMessage },
            { quoted: quotemek || mek }
          );

          await updateCMDStore(text.key.id, CMD_ID_MAP);
        }
      };
////////////////////////////////////////
//////////// ( COMMAND ADD ) ///////////
///////////////////////////////////////

  cmd({
    pattern: "ping",
    alias: ["speed", "pong"],
    use: '.ping',
    desc: "Check bot's response time.",
    category: "main",
    react: "⚡",
    filename: __filename
},
async (socket, mek, m, { from, quoted, sender, reply }) => {
    try {
        const start = Date.now();

        const reactionEmojis = ['🔥', '⚡', '🚀', '💨', '🎯', '🎉', '🌟', '💥', '🕐', '🔹'];
        const textEmojis = ['💎', '🏆', '⚡️', '🚀', '🎶', '🌠', '🌀', '🔱', '🛡️', '✨'];

        const reactionEmoji = reactionEmojis[Math.floor(Math.random() * reactionEmojis.length)];
        let textEmoji = textEmojis[Math.floor(Math.random() * textEmojis.length)];

        // Ensure reaction and text emojis are different
        while (textEmoji === reactionEmoji) {
            textEmoji = textEmojis[Math.floor(Math.random() * textEmojis.length)];
        }

        // Send reaction to user message
        await socket.sendMessage(from, {
            react: { text: textEmoji, key: mek.key }
        });

        const end = Date.now();
        const responseTime = end - start; // in milliseconds

        const text = `> _*Powered By Manaofc*_ ⚡\n\n🏓 *Pong!* ${reactionEmoji}\n⏱️ Response Time: *${responseTime} ms*`;

        // Send image with caption
        await socket.sendMessage(from, {
            image: { url: defaultConfig.IMAGE_PATH },
            caption: text
        }, { quoted: mek });

    } catch (e) {
        console.error("Error in ping command:", e);
        reply(`An error occurred: ${e.message}`);
    }
});

cmd({
  pattern: "menu",
  react: "📃",
  alias: ["panel","list","commands"],
  desc: "Get bot's command list.",
  category: "main",
  use: '.menu',
  filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

if(os.hostname().length == 12 ) hostname = 'replit'
else if(os.hostname().length == 36) hostname = 'heroku'
else if(os.hostname().length == 8) hostname = 'koyeb'
else hostname = os.hostname()
let monspace ='```'
const buttons = [
{buttonId: prefix + 'downmenu' , buttonText: {displayText: 'DOWNLOAD MENU'}, type: 1},
{buttonId: prefix + 'searchmenu' , buttonText: {displayText: 'SEARCH MENU'}, type: 1},
{buttonId: prefix + 'convertmenu' , buttonText: {displayText: 'CONVERT MENU'}, type: 1},
{buttonId: prefix + 'logomenu' , buttonText: {displayText: 'LOGO MENU'}, type: 1},
{buttonId: prefix + 'othersmenu' , buttonText: {displayText: 'OTHERS MENU'}, type: 1},
{buttonId: prefix + 'ownermenu' , buttonText: {displayText: 'OWNER MENU'}, type: 1},
{buttonId: prefix + 'moviemenu' , buttonText: {displayText: 'MOVIE MENU'}, type: 1},
]
const buttonMessage = {
  image: defaultConfig.IMAGE_PATH,
  caption: `
*╭─「 ᴄᴏᴍᴍᴀɴᴅꜱ ᴘᴀɴᴇʟ」──○●►*
*│◈ ᴏᴡɴᴇʀ : manaofc*
*│◈ ᴠᴇʀꜱɪᴏɴ : V.6*
*│◈ ʀᴜɴᴛɪᴍᴇ : ${runtime(process.uptime())}*
*│◈ ʀᴀᴍ ᴜꜱᴀɢᴇ : ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB / ${Math.round(require('os').totalmem / 1024 / 1024)}MB*
*╰─────────────────○●►*
`,
  footer: '> _*Powered By Manaofc*_ ',
  buttons: buttons,
  headerType: 4
}
return await socket.buttonMessage(from, buttonMessage, mek)
} catch (e) {
reply('*Error !!*')
console.log(e)
}
})

cmd({
    pattern: "downmenu",
    react: "📥",
    dontAddCommandList: true,
    filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

let menuc = `
*📥 MANISHA-MD-V6 DOWNLOAD MENU. 📥*\n\n`
for (let i=0;i<commands.length;i++) { 
if(commands[i].category === 'download'){
  if(!commands[i].dontAddCommandList){
menuc += `*╭──────────────────❥*
*╎🔖Command :* ${commands[i].pattern}
*╎🏷️Desc :* ${commands[i].desc}
*╎ 🧧Use:* ${commands[i].use}
*╰──────────────────❥*\n\n
`
}}};

let generatebutton = [{
    buttonId: `${prefix}ping`,
    buttonText: {
        displayText: 'GET BOT\'S PING'
    },
    type: 1
  }]
  let buttonMessaged = {
    image: defaultConfig.IMAGE_PATH,
    caption: menuc,
    footer: '> _*Powered By Manaofc*_ ',
    headerType: 4,
    buttons: generatebutton
  };
  return await socket.buttonMessage(from, buttonMessaged, mek);
} catch (e) {
  reply('*ERROR !!*')
  console.log(e)
}
})

cmd({
    pattern: "searchmenu",
    react: "🔍",
    dontAddCommandList: true,
    filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

let menuc = `
*🔍 MANISHA-MD-V6 SEARCH MENU. 🔍*\n\n`
for (let i=0;i<commands.length;i++) { 
if(commands[i].category === 'search'){
  if(!commands[i].dontAddCommandList){
menuc += `*╭──────────────────❥*
*╎🔖Command :* ${commands[i].pattern}
*╎🏷️Desc :* ${commands[i].desc}
*╎ 🧧Use:* ${commands[i].use}
*╰──────────────────❥*\n\n
`
}}};
let generatebutton = [{
    buttonId: `${prefix}ping`,
    buttonText: {
        displayText: 'GET BOT\'S PING'
    },
    type: 1
  }]
  let buttonMessaged = {
    image: defaultConfig.IMAGE_PATH,
    caption: menuc,
    footer: '> _*Powered By Manaofc*_ ',
    headerType: 4,
    buttons: generatebutton
  };
  return await socket.buttonMessage(from, buttonMessaged, mek);
} catch (e) {
  reply('*ERROR !!*')
  console.log(e)
}
})

cmd({
    pattern: "convertmenu",
    react: "🪄",
    dontAddCommandList: true,
    filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

let menuc = `
*🪄 MANISHA-MD-V6  CONVERT MENU. 🪄*\n\n`
for (let i=0;i<commands.length;i++) { 
if(commands[i].category === 'convert'){
  if(!commands[i].dontAddCommandList){
menuc += `*╭──────────────────❥*
*╎🔖Command :* ${commands[i].pattern}
*╎🏷️Desc :* ${commands[i].desc}
*╎ 🧧Use:* ${commands[i].use}
*╰──────────────────❥*\n\n
`
}}};
let generatebutton = [{
    buttonId: `${prefix}ping`,
    buttonText: {
        displayText: 'GET BOT\'S PING'
    },
    type: 1
  }]
  let buttonMessaged = {
    image: defaultConfig.IMAGE_PATH,
    caption: menuc,
    footer: '> _*Powered By Manaofc*_ ',
    headerType: 4,
    buttons: generatebutton
  };
  return await socket.buttonMessage(from, buttonMessaged, mek);
} catch (e) {
  reply('*ERROR !!*')
  console.log(e)
}
})

cmd({
    pattern: "othersmenu",
    react: "🎐",
    dontAddCommandList: true,
    filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

let menuc = `
*🎐  MANISHA-MD-V6 OTHER MENU. 🎐*\n\n`
for (let i=0;i<commands.length;i++) { 
if(commands[i].category === 'others'){
if(!commands[i].dontAddCommandList){
menuc += `*╭──────────────────❥*
*╎🔖Command :* ${commands[i].pattern}
*╎🏷️Desc :* ${commands[i].desc}
*╎ 🧧Use:* ${commands[i].use}
*╰──────────────────❥*\n\n
`
}}};
let generatebutton = [{
    buttonId: `${prefix}ping`,
    buttonText: {
        displayText: 'GET BOT\'S PING'
    },
    type: 1
  }]
  let buttonMessaged = {
    image: defaultConfig.IMAGE_PATH,
    caption: menuc,
    footer: '> _*Powered By Manaofc*_ ',
    headerType: 4,
    buttons: generatebutton
  };
  return await socket.buttonMessage(from, buttonMessaged, mek);
} catch (e) {
  reply('*ERROR !!*')
  console.log(e)
}
})

cmd({
  pattern: "ownermenu",
  react: "🗣️",
  dontAddCommandList: true,
  filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

let menuc = `
*🗣️ MANISHA-MD-V6 OWNER MENU. 🗣️*\n\n`
for (let i=0;i<commands.length;i++) { 
if(commands[i].category === 'owner'){
if(!commands[i].dontAddCommandList){
menuc += `*╭──────────────────❥*
*╎🔖Command :* ${commands[i].pattern}
*╎🏷️Desc :* ${commands[i].desc}
*╎ 🧧Use:* ${commands[i].use}
*╰──────────────────❥*\n\n
`
}}};
let generatebutton = [{
    buttonId: `${prefix}ping`,
    buttonText: {
        displayText: 'GET BOT\'S PING'
    },
    type: 1
  }]
let buttonMessaged = {
  image: defaultConfig.IMAGE_PATH,
  caption: menuc,
  footer: '> _*Powered By Manaofc*_ ',
  headerType: 4,
  buttons: generatebutton
};
return await socket.buttonMessage(from, buttonMessaged, mek);
} catch (e) {
reply('*ERROR !!*')
console.log(e)
}
})

cmd({
  pattern: "moviemenu",
  react: "🎬",
  dontAddCommandList: true,
  filename: __filename
},
async(socket, mek, m, { from, prefix, q, reply }) => {
  try {

let menuc = `
*🎬MANISHA-MD-V6 MOVIE MENU. 🎬*\n\n`
for (let i=0;i<commands.length;i++) { 
if(commands[i].category === 'movie'){
if(!commands[i].dontAddCommandList){
menuc += `*╭──────────────────❥*
*╎🔖Command :* ${commands[i].pattern}
*╎🏷️Desc :* ${commands[i].desc}
*╎ 🧧Use:* ${commands[i].use}
*╰──────────────────❥*\n\n
`
}}};
let generatebutton = [{
    buttonId: `${prefix}ping`,
    buttonText: {
        displayText: 'GET BOT\'S PING'
    },
    type: 1
  }]
let buttonMessaged = {
  image: defaultConfig.IMAGE_PATH,
  caption: menuc,
  footer: '> _*Powered By Manaofc*_ ',
  headerType: 4,
  buttons: generatebutton
};
return await socket.buttonMessage(from, buttonMessaged, mek);
} catch (e) {
reply('*ERROR !!*')
console.log(e)
}
})

    /* ================== SONG SEARCH ================== */
    cmd(
        {
            pattern: "song",
            react: "🎵",
            alias: ["music", "yt"],
            category: "download",
            use: ".song <Song Name or YouTube URL>",
            filename: __filename,
        },
        async (socket, mek, m, { from, prefix, q, reply }) => {
            try {
                if (!q) return reply("❌ *Please provide a song name or YouTube URL!*");

                const search = await yts(q);
                if (!search.videos || search.videos.length === 0)
                    return reply("⚠️ *No song results found!*");

                const song = search.videos[0];

                const caption = `
*🎶 MANISHA-MD-V6 SONG DOWNLOAD.📥*
╭──────────────────❥
│✨ \`Title\` : ${song.title}
│⏰ \`Duration\` : ${song.timestamp}
│👀 \`Views\` : ${song.views}
│ 📅 \`Uploaded\` : ${song.ago}
│ 📺 \`Channel\` : ${song.author.name}
╰──────────────────❥
> _*Powered By Manaofc*_ 
`;

                const buttons = [
                    { buttonId: `${prefix}yta ${song.url}`, buttonText: { displayText: "AUDIO TYPE 🎙" }, type: 1 },
                    { buttonId: `${prefix}ytd ${song.url}`, buttonText: { displayText: "DOCUMENT TYPE 📁" }, type: 1 },
                ];

                const buttonMessage = {
                    image: song.thumbnail,
                    caption: caption,
                    footer: "> _Powered By Manaofc_",
                    buttons: buttons,
                    headerType: 4,
                };

                await socket.buttonMessage(from, buttonMessage, mek);
            } catch (e) {
                console.log(e);
                reply("❌ *An error occurred while searching!*");
            }
        }
    );

    /* ================== AUDIO DOWNLOAD ================== */
    cmd({ 
      pattern: "yta", 
      react: "⬇️", 
      dontAddCommandList: true, 
      filename: __filename 
    },
        async (socket, mek, m, { from, q, reply }) => {
            try {
                if (!q) return reply("❌ *Need a YouTube URL!*");

                await socket.sendMessage(from, { react: { text: "⬇️", key: mek.key } });

                const apiUrl = `https://api-dark-shan-yt.koyeb.app/download/ytmp3-v2?url=${encodeURIComponent(q)}`;
                const res = await axios.get(apiUrl, { timeout: 30000 });
                const data = res.data;

                if (!data.status || !data.data?.download)
                    return reply("❌ *Failed to fetch audio link!*");

                await socket.sendMessage(from, { audio: { url: data.data.download }, mimetype: "audio/mpeg" }, { quoted: mek });
                await socket.sendMessage(from, { react: { text: "✔️", key: mek.key } });
            } catch (e) {
                console.log(e);
                reply("❌ *Audio download failed!*");
            }
        }
    );

    /* ================== DOCUMENT DOWNLOAD ================== */
    cmd({ 
      pattern: "ytd", 
      react: "📁", 
      dontAddCommandList: true, 
      filename: __filename 
    },
        async (socket, mek, m, { from, q, reply }) => {
            try {
                if (!q) return reply("❌ *Need a YouTube URL!*");

                await socket.sendMessage(from, { react: { text: "⬇️", key: mek.key } });

                const apiUrl = `https://api-dark-shan-yt.koyeb.app/download/ytmp3-v2?url=${encodeURIComponent(q)}`;
                const res = await axios.get(apiUrl, { timeout: 30000 });
                const data = res.data;

                if (!data.status || !data.data?.download)
                    return reply("❌ *Failed to fetch document link!*");

                const title = data.data.title || "Manaofc-Music";

                await socket.sendMessage(
                    from,
                    { document: { url: data.data.download }, mimetype: "audio/mpeg", fileName: `${title}.mp3` },
                    { quoted: mek }
                );

                await socket.sendMessage(from, { react: { text: "✔️", key: mek.key } });
            } catch (e) {
                console.log(e);
                reply("❌ *Document download failed!*");
            }
        }
    );

cmd({
    pattern: "xnxx",
    desc: "Download XNXX Video",
    use: ".xnxx <query>",
    react: "🔞",
    category: "download",
    filename: __filename
},

async (socket, mek, m, { from, prefix, q, reply }) => {
    try {            
        if (!q) return await reply('*Please enter a query!*')
      
      const res = await fetchJson(`https://manaofc-xnxx-api-7cc70cbd0adc.herokuapp.com/search?q=${encodeURIComponent(q)}&api_key=manaofc-v6`)

        // ✅ FIX HERE (results instead of result)
        if (!res.success || !res.results || res.results.length === 0) {
            return reply('*❌ No results found!*')
        }

        const data = res.results

        const rows = data.slice(0, 50).map((v) => ({
            buttonId: `${prefix}xnxxvid ${v.url}`,
            buttonText: { 
                displayText: v.title.length > 40 
                    ? v.title.slice(0, 37) + "..." 
                    : v.title 
            },
            type: 1,
        }))

        const buttonMessage = {
            image: defaultConfig.IMAGE_PATH,
            caption: `*MANISHA-MD-V6 XNXX DOWNLOAD 🤫*`,
            footer: '> _*Powered By Manaofc*_',
            buttons: rows,
            headerType: 4
        }


        return await socket.buttonMessage(from, buttonMessage, mek)
    } catch (e) {
      console.log(e)
      reply('*❌ Error occurred!*');
    }
  }
)

cmd({
    pattern: "xnxxvid",
    react: "⬇️",
    dontAddCommandList: true,
    filename: __filename
},

async (socket, mek, m, { from, q, reply }) => {
try {

    if (!q) return await reply('*Need a video url!*')

      const res = await fetchJson(`https://manaofc-xnxx-api-7cc70cbd0adc.herokuapp.com/video?url=${encodeURIComponent(q)}&api_key=manaofc-v6`)


    if (!res.success || !res.data) 
        return reply('*❌ Failed to fetch video!*')

    let data = res.data

    let caption = `
*🔞 XNXX VIDEO DOWNLOAD*

╭──────────────────❥
│🎬 \`Title\` : ${data.title}
│⏱ \`Duration\` : ${data.duration}
│👀 \`Views\` : ${data.views}
│👍 \`Likes\` : ${data.likes}
│⭐ \`Rating\` : ${data.rating}
╰──────────────────❥
`

    await socket.sendMessage(from, { react: { text: '⬆', key: mek.key }})

    await socket.sendMessage(from, {
        image: { url: data.thumbnail },
        caption: caption
    }, { quoted: mek })

    await socket.sendMessage(from, {
        video: { url: data.dlink },
        mimetype: "video/mp4"
    }, { quoted: mek })

    await socket.sendMessage(from, { react: { text: '✔', key: mek.key }})

} catch (e) {
    console.log(e)
    reply('*❌ Download failed!*')
}
})

//========== xvideo download ============
cmd({
    pattern: "xvideo",
    desc: "Search xvideos",
    use: ".xnxx <query>",
    react: "🔞",
    category: "download",
    filename: __filename
},

async (conn, mek, m, { from, prefix, q, reply }) => {
try {

if (!q) return reply("*Please enter a search query!*")

// API SEARCH
const res = await fetchJson(`https://api.giftedtech.co.ke/api/search/xvideossearch?apikey=gifted&query=${encodeURIComponent(q)}`)

if (!res.success || !res.results || res.results.length === 0) {
return reply("*❌ No results found!*")
}

let results = res.results

// limit buttons
const rows = results.slice(0,50).map((v,i)=>({
buttonId: `${prefix}xvid ${v.url}`,
buttonText:{
displayText: v.title ? v.title.slice(0,50) : `Video ${i+1}`
},
type:1
}))

const buttonMessage = {
image: defaultConfig.IMAGE_PATH,
caption:`*MANISHA-MD XVIDEO DOWNLOAD 🔞*`,
footer:`> _*Powered By Manaofc*_`,
buttons: rows,
headerType:4
}

return await socket.buttonMessage(from, buttonMessage, mek)
    } catch (e) {
      console.log(e)
      reply('*❌ Error occurred!*');
    }
  }
)


// XVIDEO DOWNLOAD

cmd({
pattern:"xvid",
react:"⬇️",
dontAddCommandList:true,
filename:__filename
},

async (socket, mek, m, { from, q, reply }) => {

try{

if(!q) return reply("*Please provide video url!*")

// API DOWNLOAD
const res = await fetchJson(`https://api.giftedtech.co.ke/api/download/xvideosdl?apikey=gifted&url=${encodeURIComponent(q)}`)

if(!res.success || !res.result) return reply("*❌ Failed to fetch video!*")

let data = res.result

let caption = `
*VIDEO DOWNLOADER*

╭──────────────❍
│ 🎬 *Title* : ${data.title || "Unknown"}
│ 👀 *Views* : ${data.views || "N/A"}
│ 👍 *Likes* : ${data.likes || "N/A"}
│ 👎 *Dislikes* : ${data.dislikes || "N/A"}
│ 📦 *Size* : ${data.size || "Unknown"}
╰──────────────❍
`

await socket.sendMessage(from,{ react:{ text:"⬆️", key: mek.key }})

// send thumbnail + info
await socket.sendMessage(from,{
image:{ url: data.thumbnail },
caption: caption
},{quoted: mek})

// send video
await socket.sendMessage(from,{
video:{ url: data.download_url },
mimetype:"video/mp4"
},{quoted: mek})

await socket.sendMessage(from,{ react:{ text:"✅", key: mek.key }})

}catch(e){
console.log(e)
reply("*❌ Download failed!*")
}

})


cmd(
  {
    pattern: "apk",
    react: "📦",
    alias: ["app", "playstore"],
    category: "download",
    use: ".apk *<Apk Name>*",
    filename: __filename,
  },
  async (socket, mek, m, { from, prefix, q, reply }) => {
    try {
      if (!q) return await reply(imgMsg, mek);
      const data = await apkdl.search(q);
      if (!data.length) return await reply("*couldn't find anything*");

      const rows = data.map(v => ({
        buttonId: `${prefix}dapk ${v.id}`,
        buttonText: { displayText: `${v.name}` },
        type: 1,
      }));

      const buttonMessage = {
        image: defaultConfig.IMAGE_PATH,
        caption: `*MANISHA-MD-V6 APK DOWNLOAD.* 📦`,
        footer: '> _*Powered By Manaofc*_ ',
        buttons: rows,
        headerType: 4,
      };

      return await socket.buttonMessage(from, buttonMessage, mek);
    } catch (e) {
      console.error(e);
      reply("*ERROR !!*");
    }
  }
);

cmd(
  {
    pattern: "dapk",
    react: "📦",
    dontAddCommandList: true,
    filename: __filename,
  },
  async (socket, mek, m, { from, q, reply }) => {
    try {
      await socket.sendMessage(from, { react: { text: "🌟", key: mek.key } });
      if (!q) return await reply("*Need apk link...❗*");

      const data = await apkdl.download(q);
      const caption = `📥 *MANISHA-MD-V6 APK DOWNLOAD* 📥\n\n` +
        `◈ *🏷️  :* ${data.name}\n` +
        `◈ *👤 Developers :* ${data.package}\n` +
        `◈ *📆 Last Update :* ${data.lastup}\n` +
        `◈ *📥 Size :* ${data.size}\n\n> _*Powered By Manaofc*_`;

      await socket.sendMessage(from, { image: { url: data.icon }, caption }, { quoted: mek });

      await socket.sendMessage(from, {
        document: { url: data.dllink },
        mimetype: "application/vnd.android.package-archive",
        fileName: `${data.name}.apk`,
        caption: '> _*Powered By Manaofc*_ ',
      }, { quoted: mek });
      
      await socket.sendMessage(from, { react: { text: "✔", key: mek.key } });
    } catch (e) {
      console.error(e);
      reply(`_An Error Found_ : *${e}*`);
    }
  }
);

// Mapping common file extensions to MIME types
const mimeTypes = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".rar": "application/x-rar-compressed",
  ".7z": "application/x-7z-compressed",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".exe": "application/octet-stream",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  // Add more as needed
};

// Function to format file size
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const maxSize = 4 * 1024 * 1024 * 1024; // 4GB size limit

async function MegaDl(url) {
  let res = { error: true };

  if (!url) return res;

  try {
    const file = File.fromURL(url);
    await file.loadAttributes();

    const fileExtension = path.extname(file.name).toLowerCase();
    const mimeType = mimeTypes[fileExtension] || "application/octet-stream"; // Default MIME type for unknown file types

    // Check file size
    if (file.size > maxSize) {
      return { error: true, message: "File size exceeds the 4GB limit." };
    }

    const fileInfo = {
      fileName: file.name,
      fileSize: formatBytes(file.size),
      fileSizeb: file.size,
      mimeType: mimeType
    };

    // Download file buffer
    const data = await file.downloadBuffer();

    return {
      error: false,
      fileInfo: fileInfo,
      data: data
    };
  } catch (e) {
    console.log(e);
    return res;
  }
}

// Mega command to handle Mega file download
cmd({
  pattern: "mega",
  alias: ["megadl", "meganz"],
  react: '📦',
  desc: "Download files from Mega.",
  category: "download",
  use: '.mega *<Mega URL>*',
  filename: __filename
},
async(socket, mek, m, { from, q, reply }) => {
  try {
    if (!q) return await reply('*Please provide a Mega URL!*');

    // Call MegaDl function to get file metadata and download URL
    let res = await MegaDl(q);

    if (res.error) {
      return await reply(res.message || "An error occurred while processing the Mega URL.");
    }

    const { fileInfo, data } = res;
    const { fileName, mimeType, fileSizeb } = fileInfo;

    // Check file size (4GB)
    if (fileSizeb > maxSize) {
      return await socket.sendMessage(from, { text: '🚩 *File size is too big...*' }, { quoted: mek });
    }

    // Prepare message with file metadata
    const caption = `*◈ File name:*  ${fileName}
*◈ File Size:* ${fileInfo.fileSize}
*◈ File type:* ${mimeType}

> _*Powered By Manaofc*_`;

    // Send the file to the user
    const message = {
      document: data,
      mimetype: mimeType,
      fileName: fileName,
      caption: caption,
    };

    await socket.sendMessage(from, message, { quoted: mek });

  } catch (e) {
    console.log(e); // Log the error
    reply(`${e}`); // Send the error message to the user
  }
});

// Function to download Google Drive file
async function GDriveDl(url) {
  let id, res = { error: true };

  if (!url || !url.match(/drive\.google/i)) return res;

  try {

    const match = url.match(/[-\w]{25,}/);
    if (!match) throw "ID Not Found";

    id = match[0];

    const response = await fetch(`https://drive.google.com/uc?id=${id}&export=download`, {
      method: "POST",
      headers: {
        "accept-encoding": "gzip, deflate, br",
        "content-length": 0,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        origin: "https://drive.google.com",
        "user-agent": "Mozilla/5.0",
        "x-json-requested": "true"
      }
    });

    let json;

    try {
      json = JSON.parse((await response.text()).slice(4));
    } catch {
      return { error: true };
    }

    let { fileName, sizeBytes, downloadUrl } = json;

    if (!downloadUrl) throw "Download link not available";

    const head = await fetch(downloadUrl);

    return {
      downloadUrl: downloadUrl,
      fileName: fileName || "file",
      fileSize: formatBytes(sizeBytes),
      fileSizeb: Number(sizeBytes) || 0,
      mimetype: head.headers.get("content-type") || "application/octet-stream",
      error: false
    };

  } catch (e) {
    console.log(e);
    return { error: true };
  }
}

cmd({
  pattern: "gdrive",
  alias: ["googledrive"],
  react: "📁",
  desc: "Download Google Drive files.",
  category: "download",
  use: ".gdrive <url>",
  filename: __filename
},
async (socket, mek, m, { from, q, reply }) => {

  try {

    if (!q) return reply("*Please provide a Google Drive URL!*");

    let res = await GDriveDl(q);

    if (!res || res.error) {
      return reply("*Failed to fetch the file. Make sure the file is public.*");
    }

    const fileName = res.fileName || "file";
    const fileExtension = path.extname(fileName).toLowerCase();

    let mimetype = mimeTypes[fileExtension] || res.mimetype || "application/octet-stream";

    if (res.fileSizeb > maxSize) {
      return socket.sendMessage(from,{
        text:"🚩 *File size is too big (Max 4GB)*"
      },{ quoted: mek });
    }

    const response = await axios.get(res.downloadUrl,{
      responseType:"arraybuffer"
    });

    const mediaBuffer = Buffer.from(response.data);

    const caption =
`*◈ File name:* ${fileName}
*◈ File Size:* ${res.fileSize}
*◈ File type:* ${mimetype}

> _Powered By Manaofc_`;

    await socket.sendMessage(from,{
      document: mediaBuffer,
      mimetype: mimetype,
      fileName: fileName,
      caption: caption
    },{ quoted: mek });

  } catch (e) {

    console.log(e);

    reply("*Error:* " + e);

  }

});
  
// MediaFire command to handle file download
async function mfire(url) {
  try {
    const response = await fetch(`https://www-mediafire-com.translate.goog/${url.replace("https://www.mediafire.com/", "")}?_x_tr_sl=en&_x_tr_tl=fr&_x_tr_hl=en&_x_tr_pto=wapp`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.178 Safari/537.36",
      },
    });

    const data = await response.text();
    const $ = cheerio.load(data);

    const downloadUrl = ($("#downloadButton").attr("href") || "").trim();
    const alternativeUrl = ($("#download_link > a.retry").attr("href") || "").trim();
    const $intro = $("div.dl-info > div.intro");

    return {
      link: downloadUrl || alternativeUrl,
      name: $intro.find("div.filename").text().trim(),
      size: $intro.find("div.filetype > span").eq(0).text().trim(),
      uploaded: $("div.dl-info > ul.details > li").eq(1).find("span").text().trim(),
      mime: /\(\.(.*?)\)/.exec($intro.find("div.filetype > span").eq(1).text())?.[1]?.trim() || "bin",
    };
  } catch (error) {
    console.error(error);
  }
}

// MediaFire command to handle file download
cmd(
  {
    pattern: "mediafire",
    alias: ["mfire"],
    react: "📁",
    desc: "Download MediaFire files.",
    category: "download",
    use: ".mediafire *<MediaFire URL>*",
    filename: __filename,
  },
  async (socket, mek, m, { from, q, reply }) => {
    try {
      const res = await mfire(q);
      if (!res || !res.link) {
        return await reply("*Error:* Unable to retrieve the file from the provided URL.");
      }

      const sendmedia = res.link;
      const fileSizeInBytes = parseFloat(res.size.replace(/\D/g, "")) * 1024 * 1024;
      const fileExtension = `.${res.mime.toLowerCase()}`;
      const mimetype = mimeTypes[fileExtension] || "application/octet-stream";

      const caption = `*MANISHA-MD-V6 MEDIAFIRE DOWNLOAD.📦*\n*◈ Name:* ${res.name}\n*◈ Size:* ${res.size}\n*◈ Mimetype:* ${mimetype}\n*◈ Uploaded:* ${res.uploaded}\n\n\n> _*Powered By Manaofc*_`;

      if (fileSizeInBytes > maxSize) {
        return await reply("*This file is too big.⁉️*");
      }

      await socket.sendMessage(from, {
        document: { url: sendmedia },
        mimetype: mimetype,
        fileName: `${res.name}.${res.mime}`,
        caption: caption,
      }, { quoted: mek });

    } catch (e) {
      console.error(e);
      await reply(`*Error:* ${e}`);
    }
  }
);

  
       /////////////////
/////// other command ////////
      /////////////////

  cmd({
    pattern: "vv",
    alias: ["viewonce"],
    use: ".vv",
    desc: "Download view once media",
    category: "others",
    react: "👁️",
    filename: __filename
},
async (socket, mek, m, { from, reply }) => {
    try {

        const msg = mek

        if (!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            return reply("❌ Please reply to a ViewOnce message.");
        }

        const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;

        let mediaType;

        if (quotedMsg.imageMessage) mediaType = "image";
        else if (quotedMsg.videoMessage) mediaType = "video";
        else if (quotedMsg.audioMessage) mediaType = "audio";
        else return reply("❌ Unsupported media type.");

        const stream = await downloadContentFromMessage(
            quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.audioMessage,
            mediaType
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        if (mediaType === "image") {
            await socket.sendMessage(from, { image: buffer }, { quoted: mek });
        }

        else if (mediaType === "video") {
            await socket.sendMessage(from, { video: buffer }, { quoted: mek });
        }

        else if (mediaType === "audio") {
            await socket.sendMessage(from, {
                audio: buffer,
                mimetype: quotedMsg.audioMessage.mimetype || "audio/mpeg"
            }, { quoted: mek });
        }

    } catch (e) {
        console.error("VV Error:", e);
        reply("❌ Error while fetching ViewOnce media.");
    }
});

cmd({
    pattern: "save",
    alias: ["send"],
    use: ".save",
    desc: "Save replied status",
    category: "others",
    react: "💾",
    filename: __filename
},
async (socket, mek, m, { from, reply }) => {

    try {

        const quotedMsg = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        if (!quotedMsg) {
            return reply("❌ Please reply to a status message.");
        }

        await socket.sendMessage(from, {
            react: { text: "💾", key: mek.key }
        });

        if (quotedMsg.imageMessage) {

            const buffer = await downloadAndSaveMedia(quotedMsg.imageMessage, "image");

            await socket.sendMessage(from, {
                image: buffer,
                caption: quotedMsg.imageMessage.caption || "✅ Status Saved"
            }, { quoted: mek });

        }

        else if (quotedMsg.videoMessage) {

            const buffer = await downloadAndSaveMedia(quotedMsg.videoMessage, "video");

            await socket.sendMessage(from, {
                video: buffer,
                caption: quotedMsg.videoMessage.caption || "✅ Status Saved"
            }, { quoted: mek });

        }

        else if (quotedMsg.conversation || quotedMsg.extendedTextMessage) {

            const text = quotedMsg.conversation || quotedMsg.extendedTextMessage.text;

            await socket.sendMessage(from, {
                text: `✅ *Status Saved*\n\n${text}`
            }, { quoted: mek });

        }

        else {

            await socket.sendMessage(from, quotedMsg, { quoted: mek });

        }

    } catch (error) {

        console.error("Save Error:", error);
        reply("❌ Failed to save status.");

    }
});
              ///////////////////
////////////// SETTINGS COMMAND ////////////////
            ////////////////////



  
cmd({
pattern: "set",
dontAddCommandList: true,
filename: __filename
},
async (socket, mek, m, { from, q, reply }) => {

try {

let args = q.split(" ");

const configKey = args[0]?.toUpperCase();
const configValue = args.slice(1).join(" ");

if (!configKey || !configValue) {
return reply("⚠️ Usage: .set KEY VALUE");
}

if (!userConfig) userConfig = {};

userConfig[configKey] = configValue;

await socket.sendMessage(from,{
text:`✅ *Config Updated*

🔑 Key : ${configKey}
📌 Value : ${configValue}

> _*Powered By Manaofc*_`
},{quoted: mek})

}catch(e){
console.log(e)
reply("❌ Config update failed!")
}

});


    /* ================== MESSAGE HANDLER ================== */
    socket.ev.on("messages.upsert", async ({ messages }) => {
        const mek = messages[0];
        if (!mek.message || mek.key.remoteJid === "status@broadcast") return;

        try {
          const type = getContentType(mek.message);
          const from = mek.key.remoteJid; 
          const sender = mek.key.participant || from;
          /////////////////////////
          const isGroup = from.endsWith("@g.us");
          const botNumber = socket.user.id.split(":")[0];
          const ownerNumber = defaultConfig.OWNER_NUMBER || botNumber;
          const isOwner = sender.includes(ownerNumber);
          if (defaultConfig.WORK_TYPE === "group") {
            if (!isGroup && !isOwner) return;
          }
          if (defaultConfig.WORK_TYPE === "private") {
            if (isGroup && !isOwner) return;
          }
          /////////////////
            // === BODY EXTRACTION WITH QUOTED BUTTON SUPPORT ===
            const body =
                type === "conversation"
                    ? mek.message.conversation
                    : mek.message?.extendedTextMessage?.contextInfo?.hasOwnProperty("quotedMessage") &&
                      (await isbtnID(mek.message?.extendedTextMessage?.contextInfo?.stanzaId)) &&
                      getCmdForCmdId(
                          await getCMDStore(mek.message?.extendedTextMessage?.contextInfo?.stanzaId),
                          mek?.message?.extendedTextMessage?.text
                      )
                    ? getCmdForCmdId(
                          await getCMDStore(mek.message?.extendedTextMessage?.contextInfo?.stanzaId),
                          mek?.message?.extendedTextMessage?.text
                      )
                    : type === "extendedTextMessage"
                    ? mek.message.extendedTextMessage.text
                    : type === "imageMessage" && mek.message.imageMessage.caption
                    ? mek.message.imageMessage.caption
                    : type === "videoMessage" && mek.message.videoMessage.caption
                    ? mek.message.videoMessage.caption
                    : "";

            const prefix = userConfig.PREFIX || '.';
            const isCmd = body.startsWith(prefix);
            if (!isCmd) return;

            const command = body.slice(prefix.length).trim().split(" ").shift().toLowerCase();
            const args = body.trim().split(/ +/).slice(1);
            const q = args.join(" ");

            // Reply helper
            const reply = async (text) => {
                await socket.sendMessage(from, { text }, { quoted: mek });
            };

            // Rate limiting
            //const sender = mek.key.participant || from;
            const now = Date.now();
            if (commandCooldowns.has(sender)) {
                const diff = now - commandCooldowns.get(sender);
                if (diff < COMMAND_COOLDOWN) {
                    return reply(`⏳ Please wait ${((COMMAND_COOLDOWN - diff) / 1000).toFixed(1)}s before using another command.`);
                }
            }
            commandCooldowns.set(sender, now);

            // Find and execute command
            const cmdObj = commands.find(c => c.pattern === command || (c.alias && c.alias.includes(command)));
            if (!cmdObj) return reply(`❌ Unknown command: ${command}\nUse ${prefix}menu to see available commands.`);

          // === REACTION SUPPORT ===
          if (cmdObj.react) {
            await socket.sendMessage(from, {
              react: { text: cmdObj.react, key: mek.key }
            });
          }
            await cmdObj.function(socket, mek, mek, { from, prefix, q, args, reply });

        } catch (error) {
            console.error("Command handler error:", error);
            await socket.sendMessage(mek.key.remoteJid, {
                text: `❌ An error occurred while processing your command. Please try again.`
            }, { quoted: mek });
        }
    });

    // Cleanup old cooldowns every 10s
    setInterval(() => {
        const now = Date.now();
        for (const [user, time] of commandCooldowns) {
            if (now - time > COMMAND_COOLDOWN * 5) commandCooldowns.delete(user);
        }
    }, 10000);
}
    
//========================    
// Memory optimization: Throttle message handlers
function setupMessageHandlers(socket, userConfig) {
    let lastPresenceUpdate = 0;
    const PRESENCE_UPDATE_COOLDOWN = 5000; // 5 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Throttle presence updates
        const now = Date.now();
        if (now - lastPresenceUpdate < PRESENCE_UPDATE_COOLDOWN) {
            return;
        }

        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                lastPresenceUpdate = now;
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// Memory optimization: Batch GitHub operations
async function deleteSessionFromGitHub(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        // Delete files in sequence to avoid rate limiting
        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            await delay(500); // Add delay between deletions
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

// Memory optimization: Cache session data
const sessionCache = new Map();
const SESSION_CACHE_TTL = 300000; // 5 minutes

async function restoreSession(number) {
    try {
        if (!octokit) return null;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = sessionCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
            return cached.data;
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        // Cache the session data
        sessionCache.set(sanitizedNumber, {
            data: sessionData,
            timestamp: Date.now()
        });
        
        return sessionData;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

// Memory optimization: Cache user config
const userConfigCache = new Map();
const USER_CONFIG_CACHE_TTL = 300000; // 5 minutes

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = userConfigCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < USER_CONFIG_CACHE_TTL) {
            return cached.data;
        }
        
        let configData = { ...defaultConfig };
        
        if (octokit) {
            try {
                const configPath = `session/config_${sanitizedNumber}.json`;
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });

                const content = Buffer.from(data.content, 'base64').toString('utf8');
                const userConfig = JSON.parse(content);
                
                // Merge with default config
                configData = { ...configData, ...userConfig };
            } catch (error) {
                console.warn(`No configuration found for ${number}, using default config`);
            }
        }
        
        // Set owner number to the user's number if not set
        if (!configData.OWNER_NUMBER) {
            configData.OWNER_NUMBER = sanitizedNumber;
        }
        
        // Cache the config
        userConfigCache.set(sanitizedNumber, {
            data: configData,
            timestamp: Date.now()
        });
        
        return configData;
    } catch (error) {
        console.warn(`Error loading config for ${number}, using default config:`, error);
        return { ...defaultConfig, OWNER_NUMBER: number.replace(/[^0-9]/g, '') };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        if (octokit) {
            const configPath = `session/config_${sanitizedNumber}.json`;
            let sha;

            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });
                sha = data.sha;
            } catch (error) {
                // File doesn't exist yet, no sha needed
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: configPath,
                message: `Update config for ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
                sha
            });
        }
        
        // Update cache
        userConfigCache.set(sanitizedNumber, {
            data: newConfig,
            timestamp: Date.now()
        });
        
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

// Memory optimization: Improve auto-restart logic
function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 5;
    const RESTART_DELAY_BASE = 10000; // 10 seconds
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            // Delete session from GitHub when connection is lost
            await deleteSessionFromGitHub(number);
            
            if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
                console.log(`Max restart attempts reached for ${number}, giving up`);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                return;
            }
            
            restartAttempts++;
            const delayTime = RESTART_DELAY_BASE * Math.pow(2, restartAttempts - 1); // Exponential backoff
            
            console.log(`Connection lost for ${number}, attempting to reconnect in ${delayTime/1000} seconds (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
            
            await delay(delayTime);
            
            try {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            } catch (error) {
                console.error(`Reconnection attempt ${restartAttempts} failed for ${number}:`, error);
            }
        } else if (connection === 'open') {
            // Reset restart attempts on successful connection
            restartAttempts = 0;
        }
    });
}

// Memory optimization: Improve pairing process
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // Check if already connected
    if (activeSockets.has(sanitizedNumber)) {
        if (!res.headersSent) {
            res.send({ 
                status: 'already_connected',
                message: 'This number is already connected'
            });
        }
        return;
    }

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.windows('Chrome')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Load user config
        const userConfig = await loadUserConfig(sanitizedNumber);
        
        setupStatusHandlers(socket, userConfig);
        setupCommandHandlers(socket, sanitizedNumber, userConfig);
        setupMessageHandlers(socket, userConfig);
        setupAutoRestart(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = parseInt(userConfig.MAX_RETRIES) || 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * ((parseInt(userConfig.MAX_RETRIES) || 3) - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            
            if (octokit) {
                let sha;
                try {
                    const { data } = await octokit.repos.getContent({
                        owner,
                        repo,
                        path: `session/creds_${sanitizedNumber}.json`
                    });
                    sha = data.sha;
                } catch (error) {
                    // File doesn't exist yet, no sha needed
                }

                await octokit.repos.createOrUpdateFileContents({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`,
                    message: `Update session creds for ${sanitizedNumber}`,
                    content: Buffer.from(fileContent).toString('base64'),
                    sha
                });
                console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    
                    const userJid = jidNormalizedUser(socket.user.id);

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: userConfig.IMAGE_PATH || defaultConfig.IMAGE_PATH },
                        caption: formatMessage(
                            'MANISHA-MD-V6 BOT CONNECTED',
`✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n✨ Bot is now active and ready to use!\n\n📌 Type ${userConfig.PREFIX || '.'}menu to view all commands`,
' _*Powered By Manaofc*_'
                        )
                    });


                    await sendAdminConnectMessage(socket, sanitizedNumber);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || '𝐀𝐫𝐬𝐥𝐚𝐧-𝐌𝐃-𝐌𝐢𝐧𝐢-𝐅𝚁𝙴𝙴-𝐁𝙾𝚃-session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// API Routes - Only essential routes kept
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

// Memory optimization: Limit concurrent connections
const MAX_CONCURRENT_CONNECTIONS = 5;
let currentConnections = 0;

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        const connectionPromises = [];
        
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent connections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            connectionPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(connectionPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

// Memory optimization: Limit concurrent reconnections
router.get('/reconnect', async (req, res) => {
    try {
        if (!octokit) {
            return res.status(500).send({ error: 'GitHub integration not configured' });
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        const reconnectPromises = [];
        
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent reconnections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            reconnectPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    console.error(`Failed to reconnect bot for ${number}:`, error);
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(reconnectPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

// Config management routes for HTML interface
router.get('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const config = await loadUserConfig(number);
        res.status(200).send(config);
    } catch (error) {
        console.error('Failed to load config:', error);
        res.status(500).send({ error: 'Failed to load config' });
    }
});

router.post('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const newConfig = req.body;
        
        // Validate config
        if (typeof newConfig !== 'object') {
            return res.status(400).send({ error: 'Invalid config format' });
        }
        
        // Load current config and merge
        const currentConfig = await loadUserConfig(number);
        const mergedConfig = { ...currentConfig, ...newConfig };
        
        await updateUserConfig(number, mergedConfig);
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

// Cleanup with better memory management
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
    
    // Clear all caches
    adminCache = null;
    adminCacheTime = 0;
    sessionCache.clear();
    userConfigCache.clear();
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'BOT-session'}`);
});

// Regular memory cleanup
setInterval(() => {
    // Clean up expired cache entries
    const now = Date.now();
    
    // Clean session cache
    for (let [key, value] of sessionCache.entries()) {
        if (now - value.timestamp > SESSION_CACHE_TTL) {
            sessionCache.delete(key);
        }
    }
    
    // Clean user config cache
    for (let [key, value] of userConfigCache.entries()) {
        if (now - value.timestamp > USER_CONFIG_CACHE_TTL) {
            userConfigCache.delete(key);
        }
    }
    
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
}, 300000); // Run every 5 minutes

module.exports = router;
