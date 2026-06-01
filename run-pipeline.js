const fs = require('fs');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const cheerio = require('cheerio');

const rssParser = new Parser();
const imageCache = new Map();
let sentHistory = [];

// Загрузка истории отправленных новостей
function loadHistory() {
  try {
    if (fs.existsSync('history.json')) {
      sentHistory = JSON.parse(fs.readFileSync('history.json', 'utf8'));
    }
  } catch(e) {}
}
function saveHistory() {
  fs.writeFileSync('history.json', JSON.stringify(sentHistory.slice(0, 500)), 'utf8');
}
function isDuplicate(title) {
  return sentHistory.includes(title.toLowerCase().trim());
}
function addToHistory(titles) {
  sentHistory.unshift(...titles.map(t => t.toLowerCase().trim()));
  sentHistory = [...new Set(sentHistory)].slice(0, 500);
  saveHistory();
}

// Парсинг og:image из HTML
async function fetchOgImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  try {
    const resp = await fetch(url, { timeout: 5000 });
    const html = await resp.text();
    const $ = cheerio.load(html);
    let img = $('meta[property="og:image"]').attr('content');
    if (!img) img = $('meta[name="twitter:image"]').attr('content');
    if (!img) img = $('img').first().attr('src');
    if (img && !img.startsWith('http')) {
      const base = new URL(url).origin;
      img = new URL(img, base).href;
    }
    imageCache.set(url, img || null);
    return img || null;
  } catch(e) {
    imageCache.set(url, null);
    return null;
  }
}

// ----- Агенты -----
async function executeNewsAggregator(agent, input) {
  const urls = (agent.feeds || '').split('\n').filter(s => s.trim());
  if (!urls.length) return '❌ Нет RSS-лент';
  const max = agent.maxPerFeed || 3;
  let allTitles = [];
  for (const url of urls) {
    try {
      const feed = await rssParser.parseURL(url);
      const titles = feed.items.slice(0, max).map(i => i.title);
      allTitles.push(...titles);
    } catch(e) {}
  }
  return allTitles.join('\n') || 'Нет новостей';
}

async function executeMinskNewsParser(agent, input) {
  const urls = (agent.feeds || '').split('\n').filter(s => s.trim());
  const max = agent.maxNews || 3;
  if (!urls.length) return '❌ Нет RSS-лент';
  if (agent.mode === 'mock') {
    return JSON.stringify([{ title: 'Тестовая новость Минска', imageUrl: 'https://picsum.photos/300/200', description: 'Описание', link: 'https://example.com', date: new Date().toISOString() }]);
  }
  const items = [];
  for (const feedUrl of urls) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      for (let i = 0; i < Math.min(feed.items.length, max * 2); i++) {
        const item = feed.items[i];
        let imageUrl = null;
        if (item.enclosure && item.enclosure.type?.startsWith('image')) imageUrl = item.enclosure.url;
        if (!imageUrl && item.link) imageUrl = await fetchOgImage(item.link);
        items.push({
          title: item.title,
          link: item.link,
          description: item.contentSnippet || item.title,
          imageUrl,
          date: item.isoDate || new Date().toISOString()
        });
      }
    } catch(e) { console.error(`RSS error ${feedUrl}:`, e.message); }
  }
  // Уникализация по заголовку
  const seen = new Set();
  const unique = items.filter(it => {
    const key = it.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Сортировка по дате (свежие сверху)
  unique.sort((a,b) => new Date(b.date) - new Date(a.date));
  // Отфильтровываем уже отправленные
  const fresh = unique.filter(it => !isDuplicate(it.title));
  addToHistory(fresh.map(it => it.title));
  return JSON.stringify(fresh.slice(0, max));
}

async function executeTelegramMedia(agent, input) {
  const token = process.env.TELEGRAM_TOKEN || agent.telegramToken;
  const chatId = process.env.TELEGRAM_CHAT_ID || agent.telegramChatId;
  if (!token || !chatId) throw new Error('Нет TELEGRAM_TOKEN или CHAT_ID');
  let newsArray;
  try {
    newsArray = JSON.parse(input);
    if (!Array.isArray(newsArray)) newsArray = [newsArray];
  } catch(e) {
    newsArray = [{ title: input, description: input, imageUrl: null, link: null }];
  }
  const style = agent.messageStyle || 'card';
  let sent = 0;
  for (const n of newsArray) {
    const dateStr = n.date ? new Date(n.date).toLocaleDateString('ru-RU') : '';
    let caption = '';
    if (style === 'card') {
      caption = `<b>📰 ${escapeHtml(n.title)}</b>\n\n${escapeHtml((n.description || '').slice(0, 500))}\n\n🕒 ${dateStr}\n🔗 <a href="${escapeHtml(n.link || '')}">Читать полностью</a>`;
    } else {
      caption = `📌 ${escapeHtml(n.title)}`;
    }
    try {
      if (n.imageUrl && style === 'card') {
        const form = new URLSearchParams();
        form.append('chat_id', chatId);
        form.append('photo', n.imageUrl);
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
      } else {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML', disable_web_page_preview: false })
        });
      }
      sent++;
      await new Promise(r => setTimeout(r, 300));
    } catch(err) { console.error('Telegram send error:', err.message); }
  }
  return `Отправлено ${sent} сообщений в Telegram (стиль: ${style})`;
}

async function executeQwenChat(agent, input) {
  if (agent.mode !== 'real') return `🤖 Qwen (Mock): ответ на "${input.substring(0,50)}..."`;
  const apiKey = process.env.QWEN_API_KEY || agent.apiKey;
  if (!apiKey) throw new Error('Нет API-ключа Qwen');
  const res = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: agent.model || 'qwen-plus',
      messages: [{ role: 'system', content: agent.systemPrompt || '' }, { role: 'user', content: input }],
      temperature: agent.temperature || 0.7,
      enable_search: !!agent.enableSearch
    })
  });
  if (!res.ok) throw new Error(`Qwen API error ${res.status}`);
  const data = await res.json();
  return data.choices[0]?.message?.content || 'Пустой ответ';
}

async function executeTelegramBot(agent, input) {
  const token = process.env.TELEGRAM_TOKEN || agent.telegramToken;
  const chatId = process.env.TELEGRAM_CHAT_ID || agent.telegramChatId;
  if (!token || !chatId) throw new Error('Нет токена или chat_id');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(input).substring(0, 1000), parse_mode: 'HTML' })
  });
  if (!res.ok) throw new Error(`Telegram error ${res.status}`);
  return 'Отправлено';
}

async function executeAgent(agent, input) {
  switch(agent.type) {
    case 'news_aggregator': return executeNewsAggregator(agent, input);
    case 'minsk_news_parser': return executeMinskNewsParser(agent, input);
    case 'qwen_chat': return executeQwenChat(agent, input);
    case 'telegram_media': return executeTelegramMedia(agent, input);
    case 'telegram_bot': return executeTelegramBot(agent, input);
    default: return `✅ [Mock] ${agent.name} обработал запрос`;
  }
}

// ----- Запуск пайплайна -----
async function runPipeline(agents, connections) {
  if (!agents.length) throw new Error('Нет агентов');
  agents.forEach(a => { a.status = 'idle'; a._lastResult = ''; });
  const inDegree = {};
  agents.forEach(a => inDegree[a.id] = 0);
  connections.forEach(c => { if (inDegree[c.to] !== undefined) inDegree[c.to]++; });
  let queue = agents.filter(a => inDegree[a.id] === 0);
  const completed = new Set();
  while (queue.length) {
    const ready = queue.filter(a => {
      const deps = connections.filter(c => c.to === a.id);
      return deps.every(c => completed.has(c.from));
    });
    if (!ready.length) break;
    for (const agent of ready) {
      console.log(`[${new Date().toISOString()}] [${agent.name}] ▶ Запуск...`);
      let input = '';
      const prevConns = connections.filter(c => c.to === agent.id);
      for (const pc of prevConns) {
        const prev = agents.find(a => a.id === pc.from);
        if (prev && prev._lastResult) input += (input ? '\n' : '') + prev._lastResult;
      }
      if (!input) input = agent.prompt || 'Начать';
      try {
        const result = await executeAgent(agent, input);
        agent._lastResult = typeof result === 'string' ? result : JSON.stringify(result);
        agent.status = 'completed';
        console.log(`[${new Date().toISOString()}] [${agent.name}] ✅ ${agent._lastResult.substring(0, 100)}`);
      } catch(e) {
        agent.status = 'error';
        console.error(`[${new Date().toISOString()}] [${agent.name}] ❌ ${e.message}`);
      }
      completed.add(agent.id);
    }
    queue = queue.filter(a => !completed.has(a.id));
  }
  const successCount = agents.filter(a => a.status === 'completed').length;
  console.log(`[${new Date().toISOString()}] [Система] 🏁 Завершено. Успешно: ${successCount} из ${agents.length}`);
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// ----- Точка входа -----
(async () => {
  console.log('=== NEURAL FLOW (GitHub Actions) запущен ===');
  loadHistory();
  let config;
  try {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  } catch(e) {
    console.error('Ошибка чтения config.json:', e.message);
    process.exit(1);
  }
  for (const a of config.agents) {
    if (a.type === 'telegram_media' || a.type === 'telegram_bot') {
      if (process.env.TELEGRAM_TOKEN) a.telegramToken = process.env.TELEGRAM_TOKEN;
      if (process.env.TELEGRAM_CHAT_ID) a.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    }
    if (a.type === 'qwen_chat' && process.env.QWEN_API_KEY) a.apiKey = process.env.QWEN_API_KEY;
    if (!a.mode) a.mode = 'real';
  }
  await runPipeline(config.agents, config.connections);
  console.log('✅ Пайплайн выполнен успешно');
})();
