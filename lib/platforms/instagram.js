'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Extract shortcode from various Instagram URL formats.
 */
function extractShortcode(url) {
  // Handle /share/r/ and /share/reel/ redirects first
  const share = url.match(/instagram\.com\/share\/(?:r|reel)\/([A-Za-z0-9_-]+)/);
  if (share) return share[1];

  const direct = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return direct ? direct[1] : null;
}

/**
 * Get CSRF token from Instagram.
 */
async function getCSRFToken() {
  const res = await fetch('https://www.instagram.com/', {
    headers: { 'User-Agent': UA },
  });
  const cookies = res.headers.raw()['set-cookie'] || [];
  const csrf = cookies.find(c => c.startsWith('csrftoken='));
  if (!csrf) throw new Error('Could not get CSRF token');
  return csrf.split(';')[0].replace('csrftoken=', '');
}

/**
 * Fetch full media data from Instagram GraphQL API.
 */
async function fetchMediaData(shortcode) {
  const token = await getCSRFToken();

  const variables = JSON.stringify({
    shortcode,
    fetch_tagged_user_count: null,
    hoisted_comment_id: null,
    hoisted_reply_id: null,
  });

  const body = `variables=${encodeURIComponent(variables)}&doc_id=9510064595728286`;

  const res = await fetch('https://www.instagram.com/graphql/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': token,
      'User-Agent': UA,
    },
    body,
  });

  if (!res.ok) throw new Error(`Instagram GraphQL HTTP ${res.status}`);

  const json = await res.json();
  const media = json?.data?.xdt_shortcode_media;
  if (!media) throw new Error('Пост не найден или ссылка невалидна.');
  return media;
}

/**
 * Format a number with space separators: 68744 -> "68 744"
 */
function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Format a Unix timestamp to Russian date format.
 * e.g. "15 декабря 2025 г. в 17:48 GMT+3.0"
 */
function fmtDate(ts) {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  // Convert to Moscow time (UTC+3)
  const d = new Date(ts * 1000 + 3 * 3600 * 1000);
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} г. в ${hours}:${minutes} GMT+3.0`;
}

/**
 * Build the formatted caption from media data.
 */
function buildCaption(media) {
  const owner = media.owner || {};
  const username = owner.username || 'unknown';
  const fullName = owner.full_name || username;
  const profileUrl = `https://www.instagram.com/${username}/`;

  // Location
  const loc = media.location;
  const locationStr = loc?.name || '✖️';

  // Tagged users
  const taggedEdges = media.edge_media_to_tagged_user?.edges || [];
  const taggedStr = taggedEdges.length > 0
    ? taggedEdges.map(e => `@${e.node.user.username}`).join(', ')
    : '✖️';

  // Likes & comments
  const likes = media.edge_media_preview_like?.count || 0;
  const comments = media.edge_media_to_parent_comment?.count
    || media.edge_media_preview_comment?.count || 0;

  // Date
  const dateStr = media.taken_at_timestamp
    ? fmtDate(media.taken_at_timestamp)
    : '✖️';

  // Caption/description text
  const captionEdges = media.edge_media_to_caption?.edges || [];
  const description = captionEdges.length > 0
    ? captionEdges[0].node.text
    : '';

  const lines = [
    `👤 ${fullName} (${profileUrl})`,
    '',
    `📍 Локация: ${locationStr}`,
    `🔗 Отмеченные: ${taggedStr}`,
    '',
    `❤️ ${fmtNum(likes)} шт. • 💬 ${fmtNum(comments)} шт.`,
    `🗓 ${dateStr}`,
  ];

  if (description) {
    lines.push('', 'ℹ️ Описание ↓', description);
  }

  // Telegram caption limit is 1024 chars
  let text = lines.join('\n');
  if (text.length > 1024) {
    // Trim description to fit
    const overhead = text.length - 1024;
    const trimmedDesc = description.substring(0, description.length - overhead - 3) + '...';
    lines[lines.length - 1] = trimmedDesc;
    text = lines.join('\n');
  }

  return text;
}

/**
 * Download an Instagram video. Returns { stream, caption }.
 */
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  const media = await fetchMediaData(shortcode);

  if (!media.is_video || !media.video_url) {
    throw new Error('Этот пост не содержит видео.');
  }

  const caption = buildCaption(media);
  const videoUrl = media.video_url;

  // Download video to /tmp
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
  if (stat.size === 0) throw new Error('Файл видео пуст');
  console.log(`Instagram video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));

  return { stream, caption };
}

module.exports = { getInstagramVideo };
