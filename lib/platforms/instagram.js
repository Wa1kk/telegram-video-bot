'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LSD_TOKEN = 'AVqbxe3J_YA';

// Known doc_ids — Instagram rotates them every few weeks.
// The list is tried in order; if all fail, fresh ones are scraped from IG bundles.
const KNOWN_DOC_IDS = [
  '10015901848480474',
  '9510064595728286',
  '25981206651899035',
  '8845758582119845',
];

// Cache: working doc_id persists across requests within the same serverless instance
let cachedDocId = null;

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
 * Try a single GraphQL request with a given doc_id.
 * Returns media object or null if this doc_id doesn't work.
 */
async function tryGraphQL(shortcode, docId) {
  const variables = JSON.stringify({ shortcode });
  const body = `variables=${encodeURIComponent(variables)}&doc_id=${docId}&lsd=${LSD_TOKEN}`;

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

  if (!res.ok) return null;

  const json = await res.json();
  return json?.data?.xdt_shortcode_media || null;
}

/**
 * Scrape fresh doc_ids from Instagram's JS bundles.
 * Looks for patterns like: exports="DOCID"}),null); __d("PolarisPost...
 */
async function scrapeDocIds() {
  try {
    const html = await (await fetch('https://www.instagram.com/', {
      headers: { 'User-Agent': UA },
    })).text();

    const scriptUrls = [...html.matchAll(/"(https:\/\/static\.cdninstagram\.com\/[^"]+\.js)"/g)]
      .map(m => m[1]);

    const ids = new Set();
    for (const url of scriptUrls) {
      try {
        const js = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
        // Pattern: exports="DOCID" near Post/Media/Shortcode query names
        const matches = [...js.matchAll(/exports="(\d{15,20})"\}\),null\);\s*__d\("([^"]+)"/g)];
        for (const m of matches) {
          if (/Post|Media|Shortcode/i.test(m[2])) {
            ids.add(m[1]);
          }
        }
        // Also look for doc_id:"DIGITS" pattern
        const docIdMatches = [...js.matchAll(/doc_id:\s*"(\d{15,20})"/g)];
        for (const m of docIdMatches) ids.add(m[1]);
      } catch {}
    }
    console.log(`Scraped ${ids.size} candidate doc_ids from Instagram bundles`);
    return [...ids];
  } catch (err) {
    console.error('Failed to scrape doc_ids:', err.message);
    return [];
  }
}

/**
 * Fetch media data with automatic doc_id rotation.
 * Tries cached → known list → scraped from bundles.
 */
async function fetchMediaData(shortcode) {
  // 1. Try cached doc_id first (fastest path)
  if (cachedDocId) {
    const media = await tryGraphQL(shortcode, cachedDocId);
    if (media) return media;
    console.log(`Cached doc_id ${cachedDocId} stopped working, rotating...`);
    cachedDocId = null;
  }

  // 2. Try known doc_ids
  for (const docId of KNOWN_DOC_IDS) {
    const media = await tryGraphQL(shortcode, docId);
    if (media) {
      console.log(`Working doc_id found: ${docId}`);
      cachedDocId = docId;
      return media;
    }
  }

  // 3. Scrape fresh doc_ids from Instagram JS bundles
  console.log('All known doc_ids failed, scraping fresh ones...');
  const freshIds = await scrapeDocIds();
  for (const docId of freshIds) {
    if (KNOWN_DOC_IDS.includes(docId)) continue; // already tried
    const media = await tryGraphQL(shortcode, docId);
    if (media) {
      console.log(`Fresh doc_id works: ${docId}`);
      cachedDocId = docId;
      return media;
    }
  }

  throw new Error('Instagram API недоступен — все doc_id устарели');
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
    `🗓 ${dateStr}`,
  ];

  if (description) {
    lines.push('', `📝 Описание:`, `<blockquote>${esc(description)}</blockquote>`);
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
 * Download a file from URL to /tmp, return readable stream.
 */
async function downloadToTmp(fileUrl, ext = 'mp4') {
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/ig_${id}.${ext}`;

  const response = await fetch(fileUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.instagram.com/',
    },
  });

  if (!response.ok) {
    throw new Error(`Не удалось скачать файл (HTTP ${response.status})`);
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
    throw new Error('Скачанный файл пуст');
  }
  console.log(`[IG] File: ${(stat.size / 1024 / 1024).toFixed(1)} MB (${ext})`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return stream;
}

/**
 * Extract items from a media object (handles single posts and carousels).
 * Returns array of { url, isVideo }.
 */
function extractItems(media) {
  const children = media.edge_sidecar_to_children?.edges;
  if (children && children.length > 0) {
    return children.map(e => ({
      url: e.node.is_video ? e.node.video_url : e.node.display_url,
      isVideo: !!e.node.is_video,
    })).filter(i => i.url);
  }
  // Single post
  if (media.is_video && media.video_url) {
    return [{ url: media.video_url, isVideo: true }];
  }
  if (media.display_url) {
    return [{ url: media.display_url, isVideo: false }];
  }
  return [];
}

/**
 * Download an Instagram post (video or photo). Returns { stream, caption, type, filename }
 * or { items, caption } for carousels with multiple items.
 */
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  const media = await fetchMediaData(shortcode);
  const caption = buildRichCaption(media);
  const items = extractItems(media);

  if (items.length === 0) {
    throw new Error('Не удалось найти контент в этом посте');
  }

  // Single item
  if (items.length === 1) {
    const item = items[0];
    const ext = item.isVideo ? 'mp4' : 'jpg';
    const stream = await downloadToTmp(item.url, ext);
    return {
      stream,
      caption,
      type: item.isVideo ? 'video' : 'photo',
      filename: item.isVideo ? 'video.mp4' : 'image.jpg',
    };
  }

  // Carousel — download all items
  const downloaded = [];
  for (const item of items) {
    const ext = item.isVideo ? 'mp4' : 'jpg';
    const stream = await downloadToTmp(item.url, ext);
    downloaded.push({
      stream,
      type: item.isVideo ? 'video' : 'photo',
      filename: item.isVideo ? 'video.mp4' : 'image.jpg',
    });
  }

  return { items: downloaded, caption };
}

module.exports = { getInstagramVideo };
