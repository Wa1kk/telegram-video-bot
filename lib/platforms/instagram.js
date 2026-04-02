'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Instagram rotates doc_ids every few weeks — update when requests start failing
const GRAPHQL_DOC_ID = '10015901848480474';
const LSD_TOKEN = 'AVqbxe3J_YA';

/**
 * Extract shortcode from various Instagram URL formats.
 */
function extractShortcode(url) {
  const share = url.match(/instagram\.com\/share\/(?:r|reel)\/([A-Za-z0-9_-]+)/);
  if (share) return share[1];
  const direct = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return direct ? direct[1] : null;
}

/**
 * Fetch media data from Instagram GraphQL API (no auth required).
 * Returns media object with video_url, owner, captions, etc.
 */
async function fetchMediaData(shortcode) {
  const variables = JSON.stringify({ shortcode });

  const body = `variables=${encodeURIComponent(variables)}&doc_id=${GRAPHQL_DOC_ID}&lsd=${LSD_TOKEN}`;

  const res = await fetch('https://www.instagram.com/api/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'X-IG-App-ID': '936619743392459',
      'X-FB-LSD': LSD_TOKEN,
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://www.instagram.com/',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Instagram request failed (HTTP ${res.status})`);
  }

  const json = await res.json();
  const media = json?.data?.xdt_shortcode_media;
  if (!media) {
    throw new Error('Пост не найден или недоступен');
  }
  return media;
}

// ── Formatting helpers ──

function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function fmtDate(ts) {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const d = new Date(ts * 1000 + 3 * 3600 * 1000);
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} г. в ${hours}:${minutes} GMT+3.0`;
}

/**
 * Escape HTML special chars for Telegram HTML parse_mode.
 */
function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build rich caption from full GraphQL media data (HTML format).
 */
function buildRichCaption(media) {
  const owner = media.owner || {};
  const username = owner.username || 'unknown';
  const fullName = owner.full_name || username;
  const profileUrl = `https://www.instagram.com/${username}/`;

  const loc = media.location;
  const locationStr = loc?.name ? esc(loc.name) : '✖️';

  const taggedEdges = media.edge_media_to_tagged_user?.edges || [];
  const taggedStr = taggedEdges.length > 0
    ? taggedEdges.map(e => `@${esc(e.node.user.username)}`).join(', ')
    : '✖️';

  const likes = media.edge_media_preview_like?.count || 0;
  const comments = media.edge_media_to_parent_comment?.count
    || media.edge_media_preview_comment?.count || 0;

  const dateStr = media.taken_at_timestamp
    ? fmtDate(media.taken_at_timestamp)
    : '✖️';

  const captionEdges = media.edge_media_to_caption?.edges || [];
  const description = captionEdges.length > 0
    ? captionEdges[0].node.text
    : '';

  const lines = [
    `👤 <a href="${profileUrl}">${esc(fullName)}</a>`,
    '',
    `📍 Локация: ${locationStr}`,
    `🔗 Отмеченные: ${taggedStr}`,
    '',
    `❤️ ${fmtNum(likes)} шт. • 💬 ${fmtNum(comments)} шт.`,
    '',
    `ℹ️ Описание:`,
    `🗓 ${dateStr}`,
  ];

  if (description) {
    lines.push('', `<blockquote>${esc(description)}</blockquote>`);
  }

  let text = lines.join('\n');
  if (text.length > 1024) {
    const metaLength = text.length - esc(description).length - '<blockquote></blockquote>'.length;
    const maxDesc = 1024 - metaLength - '<blockquote></blockquote>'.length - 3;
    lines[lines.length - 1] = `<blockquote>${esc(description).substring(0, maxDesc)}...</blockquote>`;
    text = lines.join('\n');
  }

  return text;
}

/**
 * Download video file from URL to /tmp, return readable stream.
 */
async function downloadToTmp(videoUrl) {
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  const response = await fetch(videoUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.instagram.com/',
    },
  });

  if (!response.ok) {
    throw new Error(`Не удалось скачать видео (HTTP ${response.status})`);
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
    throw new Error('Файл видео пуст');
  }
  console.log(`Instagram video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return stream;
}

/**
 * Download an Instagram video. Returns { stream, caption }.
 *
 * Strategy: fetch media data via GraphQL API (no auth needed),
 * extract video_url and rich metadata for caption.
 */
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  const media = await fetchMediaData(shortcode);

  if (!media.video_url) {
    throw new Error('Это не видео или пост недоступен');
  }

  const caption = buildRichCaption(media);
  const stream = await downloadToTmp(media.video_url);

  return { stream, caption };
}

module.exports = { getInstagramVideo };
