const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn, execSync } = require('child_process');
const multer = require('multer');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 10000;

const BASE_DIR = __dirname;
const UPLOAD_BASE_DIR = path.join(BASE_DIR, 'userbot');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const BOT_STATE_FILE = path.join(BASE_DIR, 'bot_status.json');
const BANNED_FILE = path.join(BASE_DIR, 'banned.json');
const KEEP_FILES = ['server.js', 'package.json', 'index.html', 'users.json', 'bot_status.json', 'banned.json', 'node_modules'];

if (!fs.existsSync(UPLOAD_BASE_DIR)) fs.mkdirSync(UPLOAD_BASE_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(BOT_STATE_FILE)) fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({}));
if (!fs.existsSync(BANNED_FILE)) fs.writeFileSync(BANNED_FILE, JSON.stringify([]));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(BASE_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const chatId = req.body.chatId;
    const userDir = path.join(UPLOAD_BASE_DIR, chatId);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users));
}
function loadBotState() {
  return JSON.parse(fs.readFileSync(BOT_STATE_FILE));
}
function saveBotState(state) {
  fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(state));
}
function loadBannedUsers() {
  return JSON.parse(fs.readFileSync(BANNED_FILE));
}
function saveBannedUsers(users) {
  fs.writeFileSync(BANNED_FILE, JSON.stringify(users));
}

app.get('/', (req, res) => {
  res.sendFile(path.join(BASE_DIR, 'index.html'));
});

app.post('/upload', upload.fields([{ name: 'botjs' }, { name: 'pkg' }]), (req, res) => {
  const chatId = req.body.chatId;
  const userDir = path.join(UPLOAD_BASE_DIR, chatId);

  const bannedUsers = loadBannedUsers();
  if (bannedUsers.includes(chatId)) {
    return res.status(403).send('❌ You are banned.');
  }

  let users = loadUsers();
  if (!users.includes(chatId)) {
    users.push(chatId);
    saveUsers(users);
  }

  exec(`cd ${userDir} && npm install`, (err) => {
    if (err) return res.status(500).send('❌ Install failed.');

    runUserBot(chatId);
    res.send('✅ Your bot is running!');
  });
});

app.post('/ban', (req, res) => {
  const userId = req.body.userId;
  let banned = loadBannedUsers();
  if (!banned.includes(userId)) {
    banned.push(userId);
    saveBannedUsers(banned);
  }
  res.send(`User ${userId} banned.`);
});

app.post('/unban', (req, res) => {
  const userId = req.body.userId;
  let banned = loadBannedUsers().filter(id => id !== userId);
  saveBannedUsers(banned);
  res.send(`User ${userId} unbanned.`);
});

const runningBots = new Map();

function runUserBot(chatId) {
  const userDir = path.join(UPLOAD_BASE_DIR, chatId.toString());
  const botPath = path.join(userDir, 'bot.js');

  if (!fs.existsSync(botPath)) {
    console.log(`❌ [${chatId}] bot.js not found.`);
    return;
  }

  if (runningBots.has(chatId)) {
    console.log(`⚠️ [${chatId}] Bot already running.`);
    return;
  }

  const child = spawn('node', ['bot.js'], {
    cwd: userDir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  runningBots.set(chatId, child);
  const botStates = loadBotState();
  botStates[chatId] = true;
  saveBotState(botStates);

  console.log(`✅ [${chatId}] Bot started.`);

  child.on('exit', (code) => {
    runningBots.delete(chatId);
    const botStates = loadBotState();
    botStates[chatId] = false;
    saveBotState(botStates);

    if (code !== 0) {
      console.log(`⚠️ [${chatId}] Bot crashed. Restarting...`);
      runUserBot(chatId);
    } else {
      console.log(`ℹ️ [${chatId}] Bot exited.`);
    }
  });
}

function autoRestartBots() {
  const botStates = loadBotState();
  Object.entries(botStates).forEach(([chatId, isRunning]) => {
    if (isRunning) {
      runUserBot(chatId);
      console.log(`🔄 [${chatId}] Auto-restarted on server start.`);
    }
  });
}
autoRestartBots();

setInterval(() => {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;

  fs.readdir(BASE_DIR, (err, items) => {
    if (err) return;
    items.forEach(item => {
      if (KEEP_FILES.includes(item)) return;
      const itemPath = path.join(BASE_DIR, item);
      fs.stat(itemPath, (err, stats) => {
        if (err) return;
        if (stats.mtimeMs < cutoff) {
          fs.rm(itemPath, { recursive: true, force: true }, () => {});
        }
      });
    });
  });
}, 60 * 60 * 1000);

setInterval(() => {
  try {
    const output = execSync('df -h /').toString();
    const usageLine = output.split('\n')[1];
    const usedPercent = parseInt(usageLine.split(/\s+/)[4].replace('%', ''));

    if (usedPercent >= 80) runCleanup();
  } catch (e) {}
}, 30 * 60 * 1000);

function runCleanup() {
  fs.readdir(BASE_DIR, (err, items) => {
    if (err) return;
    items.forEach(item => {
      if (KEEP_FILES.includes(item)) return;
      fs.rm(path.join(BASE_DIR, item), { recursive: true, force: true }, () => {});
    });
  });
}

app.listen(PORT, () => {
  console.log(`🌐 Web Bot Runner running at http://localhost:${PORT}`);
});
