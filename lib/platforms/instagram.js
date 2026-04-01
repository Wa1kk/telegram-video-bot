'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');
const { instagramGetUrl } = require('instagram-url-direct');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
 * Get CSRF token + session cookies from Instagram.
 */
async function getSession() {
  const res = await fetch('https://www.instagram.com/', {
    headers: { 'User-Agent': UA },
  });
  const rawCookies = res.headers.raw()['set-cookie'] || [];
  const cookieParts = rawCookies.map(c => c.split(';')[0]);
  const cookieString = cookieParts.join('; ');
  const csrfPart = cookieParts.find(c => c.startsWith('csrftoken='));
  if (!csrfPart) throw new Error('Could not get CSRF token');
  const csrfToken = csrfPart.replace('csrftoken=', '');
  return { csrfToken, cookieString };
}

/**
 * Try to fetch full media metadata from Instagram GraphQL API.
 * Returns media object or null on failure (non-throwing).
 */
async function tryFetchMediaData(shortcode) {
  try {
    const { csrfToken, cookieString } = await getSession();

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
        'X-CSRFToken': csrfToken,
        'Cookie': cookieString,
        'User-Agent': UA,
        'Referer': 'https://www.instagram.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'X-IG-App-ID': '936619743392459',
      },
      body,
    });

    if (!res.ok) return null;

    const json = await res.json();
    return json?.data?.xdt_shortcode_media || null;
  } catch {
    return null;
  }
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
 * Build rich caption from full GraphQL media data.
 */
function buildRichCaption(media) {
  const owner = media.owner || {};
  const username = owner.username || 'unknown';
  const fullName = owner.full_name || username;
  const profileUrl = `https://www.instagram.com/${username}/`;

  const loc = media.location;
  const locationStr = loc?.name || '✖️';

  const taggedEdges = media.edge_media_to_tagged_user?.edges || [];
  const taggedStr = taggedEdges.length > 0
    ? taggedEdges.map(e => `@${e.node.user.username}`).join(', ')
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

  let text = lines.join('\n');
  if (text.length > 1024) {
    const overhead = text.length - 1024;
    const trimmedDesc = description.substring(0, description.length - overhead - 3) + '...';
    lines[lines.length - 1] = trimmedDesc;
    text = lines.join('\n');
  }

  return text;
}

/**
 * Build basic caption from instagram-url-direct data.
 */
function buildBasicCaption(postInfo) {
  const username = postInfo.owner_username || 'unknown';
  const fullName = postInfo.owner_fullname || username;
  const profileUrl = `https://www.instagram.com/${username}/`;

  const lines = [
    `👤 ${fullName} (${profileUrl})`,
    '',
    `📍 Локация: ✖️`,
    `🔗 Отмеченные: ✖️`,
    '',
    `❤️ ${fmtNum(postInfo.likes || 0)} шт.`,
  ];

  if (postInfo.caption) {
    lines.push('', 'ℹ️ Описание ↓', postInfo.caption);
  }

  let text = lines.join('\n');
  if (text.length > 1024) text = text.substring(0, 1021) + '...';
  return text;
}

/**
 * Download video file from URL to /tmp, return { stream, outFile }.
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
 * Strategy:
 * 1. Use instagram-url-direct to get video URL (reliable, has retries)
 * 2. Try GraphQL for rich metadata (location, date, comments, tagged)
 * 3. If GraphQL fails, use basic metadata from instagram-url-direct
 */
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  // Step 1: Get video URL via instagram-url-direct (reliable with retries)
  const igResult = await instagramGetUrl(url, { retries: 5, delay: 1000 });

  if (!igResult.url_list || igResult.url_list.length === 0) {
    throw new Error('Не удалось получить ссылку на видео. Пост может быть приватным.');
  }

  const videoUrl = igResult.url_list[0];

  // Step 2: Try to get rich metadata via GraphQL (non-blocking)
  const media = await tryFetchMediaData(shortcode);

  // Step 3: Build caption — rich if GraphQL succeeded, basic otherwise
  const caption = media
    ? buildRichCaption(media)
    : buildBasicCaption(igResult.post_info || {});

  // Step 4: Download video
  const stream = await downloadToTmp(videoUrl);

  return { stream, caption };
}

module.exports = { getInstagramVideo };
