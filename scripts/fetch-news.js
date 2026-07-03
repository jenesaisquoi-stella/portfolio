#!/usr/bin/env node
/*
 * AI 产业链新闻抓取脚本
 * 运行环境：GitHub Actions（Node 18+，无需 npm install，仅用内置模块）
 * 逻辑：
 *   1. 抓取多个财经 RSS 源
 *   2. 按 AI 产业链关键词过滤 + 自动分层（up/mid/down/trend）
 *   3. 与现有 news.json 合并去重，按日期倒序，保留最新 N 条
 *   4. 写回 news.json
 *
 * 说明：RSS 源可能变动。抓取失败时保留原 news.json 不覆盖，保证页面不空。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const NEWS_FILE = path.join(__dirname, '..', 'news.json');
const MAX_ITEMS = 40;

// ---- RSS 源（可自行增删；均为公开财经/科技源）----
const FEEDS = [
  'https://rsshub.app/cls/telegraph',          // 财联社电报
  'https://rsshub.app/eastmoney/report/strategyreport', // 东财策略报告
  'https://36kr.com/feed'                        // 36氪
];

// ---- AI 产业链关键词 → 分层映射 ----
const LAYER_KEYWORDS = {
  up:   ['光模块', 'PCB', '铜缆', 'HBM', '存储芯片', 'DRAM', '覆铜板', '液冷', '连接器', '中际旭创', '新易盛', '天孚', '胜宏', '沪电', '生益', '兆易', '海力士', '美光'],
  mid:  ['英伟达', 'NVIDIA', 'GPU', '寒武纪', '昇腾', '海光', '芯片', '算力', '服务器', '工业富联', 'AI芯片', 'Rubin', 'Blackwell', '台积电'],
  down: ['DeepSeek', '智谱', '大模型', 'GLM', 'Kimi', '豆包', '通义', 'AI应用', 'Agent', '模型', 'OpenAI', 'GPT', 'Gemini'],
  trend:['机器人', '宇树', '智元', '人形', '具身智能', 'Physical AI', '自动驾驶', 'AI眼镜']
};
const ALL_KEYWORDS = Object.values(LAYER_KEYWORDS).flat();

function httpGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 news-bot' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function stripTags(s) {
  return (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item[>\s]/i).slice(1);
  for (const b of blocks) {
    const title = stripTags((b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link  = stripTags((b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const desc  = stripTags((b.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
    const pub   = stripTags((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (title) items.push({ title, link, desc, pub });
  }
  return items;
}

function classify(text) {
  for (const layer of ['up', 'mid', 'down', 'trend']) {
    if (LAYER_KEYWORDS[layer].some((k) => text.includes(k))) return layer;
  }
  return null;
}

function matchedStock(text) {
  const hit = ALL_KEYWORDS.find((k) => text.includes(k));
  return hit || 'AI 产业';
}

function toDate(pub) {
  const d = pub ? new Date(pub) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

(async function main() {
  let existing = { items: [] };
  try { existing = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8')); } catch (e) {}

  const fresh = [];
  for (const feed of FEEDS) {
    const xml = await httpGet(feed);
    if (!xml) continue;
    for (const it of parseRss(xml)) {
      const text = it.title + ' ' + it.desc;
      const layer = classify(text);
      if (!layer) continue;
      fresh.push({
        layer,
        stock: matchedStock(text),
        date: toDate(it.pub),
        title: it.title.slice(0, 80),
        summary: it.desc.slice(0, 160),
        source: 'RSS 自动抓取',
        url: it.link || ''
      });
    }
  }

  // 合并去重（按标题），新抓的在前
  const merged = [];
  const seen = new Set();
  for (const it of [...fresh, ...existing.items]) {
    const key = (it.title || '').slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
  }
  merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // 抓取全失败则保留原文件，避免页面变空
  if (fresh.length === 0 && existing.items.length) {
    console.log('未抓到新新闻，保留原 news.json');
    return;
  }

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    note: existing.note || 'AI 产业链重点新闻（自动更新）',
    items: merged.slice(0, MAX_ITEMS)
  };
  fs.writeFileSync(NEWS_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✅ 更新完成：新抓 ${fresh.length} 条，合并后 ${out.items.length} 条`);
})();
