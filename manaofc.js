const axios = require('axios');
const yts = require("yt-search");
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');

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
} = require("baileys");

const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson, getsize, formatBytes, fetchBuffer, formatSize, getFile } = require("./lib/functions");

// Default config structure
const defaultConfig = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
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
        '> _*Powered By Manaofc*_'
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
: undefined;

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
          await conn.sendMessage(jid, msgData);
        } else {

let result = "";
const CMD_ID_MAP = [];

msgData.sections.forEach((section, sectionIndex) => {

const mainNumber = `${sectionIndex + 1}`;

result += `\n*${mainNumber} :* ${section.title}\n`;

section.rows.forEach((row, rowIndex) => {

const subNumber = `${mainNumber}.${rowIndex + 1}`;

result += `◦ ${subNumber} - ${row.title}\n`;

CMD_ID_MAP.push({
cmdId: subNumber,
cmd: row.rowId
});

});

});

const listMessage = `

${msgData.text}

*╭─────────────────❥➻*
*╎* ${cos}🔢 Reply Below Number:${cos}
*╰─────────────────❥➻*

${result}

${msgData.footer || ""}
`;

const listimg = msgData.image
? { url: msgData.image }
: undefined;

const text = await socket.sendMessage(
jid,
{ image: listimg, caption: listMessage },
{ quoted: quotemek }
);

await updateCMDStore(text.key.id, CMD_ID_MAP);
}
};

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
            image: "https://i.ibb.co/S4Cf2kZg/IMG-0773.png",
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
image: "https://i.ibb.co/S4Cf2kZg/IMG-0773.png",
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

  
    /* ================== MESSAGE HANDLER ================== */
    socket.ev.on("messages.upsert", async ({ messages }) => {
        const mek = messages[0];
        if (!mek.message || mek.key.remoteJid === "status@broadcast") return;

        try {
            const type = getContentType(mek.message);
            const from = mek.key.remoteJid;

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
            const sender = mek.key.participant || from;
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
'> _*Powered By Manaofc*_'
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
