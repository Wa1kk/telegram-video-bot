'use strict';

const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

const COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Fetch TikTok metadata by scraping the page HTML.
 */
async function fetchMetadata(url) {
  const meta = { author: '', authorUrl: '', description: '' };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      },
      timeout: 10000,
      redirect: 'follow',
    });
    if (!res.ok) return meta;
    const html = await res.text();

    // Try JSON-LD or __UNIVERSAL_DATA_FOR_REHYDRATION__
    const udMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (udMatch) {
      try {
        const data = JSON.parse(udMatch[1]);
        const detail = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
        if (detail) {
          meta.author = detail.author?.nickname || detail.author?.uniqueId || '';
          meta.authorUrl = detail.author?.uniqueId
            ? `https://www.tiktok.com/@${detail.author.uniqueId}`
            : '';
          meta.description = detail.desc || '';
          return meta;
        }
      } catch {}
    }

    // Fallback: og tags
    const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/);
    if (ogTitle) meta.description = ogTitle[1];

    const ogAuthor = html.match(/"author":"@([^"]+)"/);
    if (ogAuthor) {
      meta.author = ogAuthor[1];
      meta.authorUrl = `https://www.tiktok.com/@${ogAuthor[1]}`;
    }
  } catch {}
  return meta;
}

/**
 * Build caption for Telegram.
 */
function buildCaption(meta) {
  const authorLink = meta.authorUrl
    ? `<a href="${meta.authorUrl}">${esc(meta.author)}</a>`
    : esc(meta.author);

  const lines = [];
  if (meta.author) lines.push(`👤 ${authorLink}`);
  if (meta.description) {
    lines.push('', `<blockquote>${esc(meta.description)}</blockquote>`);
  }
  if (lines.length === 0) return '🎵 TikTok';

  let text = `🎵 TikTok\n\n${lines.join('\n')}`;
  if (text.length > 1024) text = text.substring(0, 1021) + '...';
  return text;
}

/**
 * Try downloading via a single Cobalt instance.
 */
async function tryCobaltInstance(instanceUrl, tiktokUrl) {
  const res = await fetch(instanceUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: tiktokUrl,
      videoQuality: '720',
    }),
    timeout: 15000,
  });

  const data = await res.json();

  if (data.status === 'error') {
    throw new Error(`Cobalt error: ${data.error?.code || 'unknown'}`);
  }

  const videoUrl = data.url;
  if (!videoUrl) throw new Error('No video URL in cobalt response');
  return videoUrl;
}

/**
 * Download video from URL to /tmp.
 */
async function downloadToTmp(videoUrl) {
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/tiktok_${id}.mp4`;

  const response = await fetch(videoUrl, {
    headers: { 'User-Agent': UA },
    timeout: 120000,
  });

  if (!response.ok) {
    throw new Error(`Video download failed (HTTP ${response.status})`);
  }

  const fileStream = fs.createWriteStream(outFile);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
  });

  const stat = fs.statSync(outFile);
  if (stat.size === 0) {
    fs.unlinkSync(outFile);
    throw new Error('Downloaded file is empty');
  }
  console.log(`[TT] Video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return stream;
}

/**
 * Download a TikTok video via Cobalt API.
 * Returns { stream, caption }.
 */
async function getTikTokVideo(url) {
  const errors = [];

  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`[TT] Trying cobalt: ${instance}`);
      const videoUrl = await tryCobaltInstance(instance, url);

      const [meta, stream] = await Promise.all([
        fetchMetadata(url),
        downloadToTmp(videoUrl),
      ]);

      return { stream, caption: buildCaption(meta) };
    } catch (err) {
      console.warn(`[TT] ${instance} failed: ${err.message}`);
      errors.push(`${instance}: ${err.message}`);
    }
  }

  throw new Error(`Не удалось скачать видео с TikTok.\n${errors.join('\n')}`);
}

module.exports = { getTikTokVideo };
