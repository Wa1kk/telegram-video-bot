'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LSD_TOKEN = 'AVqbxe3J_YA';

const COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

const KNOWN_DOC_IDS = [
  '10015901848480474',
  '9510064595728286',
  '25981206651899035',
  '8845758582119845',
];

let cachedDocId = null;

// ── URL parsing ──

function extractShortcode(url) {
  const share = url.match(/instagram\.com\/share\/(?:r|reel)\/([A-Za-z0-9_-]+)/);
  if (share) return share[1];
  const direct = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return direct ? direct[1] : null;
}

// ── Method 1: GraphQL API ──

async function tryGraphQL(shortcode, docId) {
  try {
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
      timeout: 10000,
    });

    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.xdt_shortcode_media || null;
  } catch {
    return null;
  }
}

async function scrapeDocIds() {
  try {
    const html = await (await fetch('https://www.instagram.com/', {
      headers: { 'User-Agent': UA },
    })).text();

    const scriptUrls = [...html.matchAll(/"(https:\/\/static\.cdninstagram\.com\/[^"]+\.js)"/g)]
      .map(m => m[1]).slice(0, 10); // limit to first 10 scripts

    const ids = new Set();
    for (const url of scriptUrls) {
      try {
        const js = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
        const matches = [...js.matchAll(/exports="(\d{15,20})"\}\),null\);\s*__d\("([^"]+)"/g)];
        for (const m of matches) {
          if (/Post|Media|Shortcode/i.test(m[2])) ids.add(m[1]);
        }
        const docIdMatches = [...js.matchAll(/doc_id:\s*"(\d{15,20})"/g)];
        for (const m of docIdMatches) ids.add(m[1]);
      } catch {}
    }
    console.log(`[IG] Scraped ${ids.size} candidate doc_ids`);
    return [...ids];
  } catch (err) {
    console.error('[IG] Failed to scrape doc_ids:', err.message);
    return [];
  }
}

async function fetchMediaViaGraphQL(shortcode) {
  if (cachedDocId) {
    const media = await tryGraphQL(shortcode, cachedDocId);
    if (media) return media;
    console.log(`[IG] Cached doc_id expired, rotating...`);
    cachedDocId = null;
  }

  for (const docId of KNOWN_DOC_IDS) {
    const media = await tryGraphQL(shortcode, docId);
    if (media) {
      cachedDocId = docId;
      return media;
    }
  }

  console.log('[IG] All known doc_ids failed, scraping fresh ones...');
  const freshIds = await scrapeDocIds();
  for (const docId of freshIds) {
    if (KNOWN_DOC_IDS.includes(docId)) continue;
    const media = await tryGraphQL(shortcode, docId);
    if (media) {
      cachedDocId = docId;
      return media;
    }
  }

  return null; // don't throw — let fallback handle it
}

// ── Method 2: Cobalt API ──

async function fetchViaCobalt(url) {
  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`[IG] Trying cobalt: ${instance}`);
      const res = await fetch(instance, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
        timeout: 15000,
      });

      const data = await res.json();

      if (data.status === 'error') {
        console.warn(`[IG] Cobalt ${instance} error: ${data.error?.code}`);
        continue;
      }

      // Single media
      if (data.url) {
        const isVideo = !data.url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
        return [{ url: data.url, isVideo }];
      }

      // Carousel (picker)
      if (data.picker && data.picker.length > 0) {
        return data.picker.map(p => ({
          url: p.url,
          isVideo: p.type === 'video',
        }));
      }
    } catch (err) {
      console.warn(`[IG] Cobalt ${instance} failed: ${err.message}`);
    }
  }
  return null;
}

// ── Method 3: HTML scraping ──

async function fetchMediaFromHTML(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Look for video_url in embedded JSON
    const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (videoMatch) {
      const videoUrl = videoMatch[1].replace(/\\u0026/g, '&');
      return [{ url: videoUrl, isVideo: true }];
    }

    // Look for display_url (image)
    const imgMatch = html.match(/"display_url"\s*:\s*"([^"]+)"/);
    if (imgMatch) {
      const imgUrl = imgMatch[1].replace(/\\u0026/g, '&');
      return [{ url: imgUrl, isVideo: false }];
    }

    // og:image as last resort
    const ogMatch = html.match(/property="og:image"\s*content="([^"]+)"/);
    if (ogMatch) {
      return [{ url: ogMatch[1], isVideo: false }];
    }
  } catch (err) {
    console.warn('[IG] HTML scraping failed:', err.message);
  }
  return null;
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
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} г. в ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} GMT+3.0`;
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildRichCaption(media) {
  if (!media) return '';
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

  const dateStr = media.taken_at_timestamp ? fmtDate(media.taken_at_timestamp) : '✖️';

  const captionEdges = media.edge_media_to_caption?.edges || [];
  const description = captionEdges.length > 0 ? captionEdges[0].node.text : '';

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

// ── Download helper ──

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

// ── Extract items from GraphQL media ──

function extractItemsFromMedia(media) {
  const children = media.edge_sidecar_to_children?.edges;
  if (children && children.length > 0) {
    return children.map(e => ({
      url: e.node.is_video ? e.node.video_url : e.node.display_url,
      isVideo: !!e.node.is_video,
    })).filter(i => i.url);
  }
  if (media.is_video && media.video_url) {
    return [{ url: media.video_url, isVideo: true }];
  }
  if (media.display_url) {
    return [{ url: media.display_url, isVideo: false }];
  }
  return [];
}

// ── Main entry point ──

async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  let items = null;
  let caption = '';

  // Strategy 1: GraphQL API (best — gives media + full metadata)
  try {
    console.log('[IG] Trying GraphQL API...');
    const media = await fetchMediaViaGraphQL(shortcode);
    if (media) {
      caption = buildRichCaption(media);
      items = extractItemsFromMedia(media);
      if (items.length > 0) console.log(`[IG] GraphQL: found ${items.length} item(s)`);
      else items = null;
    }
  } catch (err) {
    console.warn('[IG] GraphQL error:', err.message);
  }

  // Strategy 2: Cobalt API (reliable fallback, no metadata)
  if (!items) {
    try {
      console.log('[IG] Trying Cobalt API...');
      items = await fetchViaCobalt(url);
      if (items) console.log(`[IG] Cobalt: found ${items.length} item(s)`);
    } catch (err) {
      console.warn('[IG] Cobalt error:', err.message);
    }
  }

  // Strategy 3: HTML scraping (last resort)
  if (!items) {
    try {
      console.log('[IG] Trying HTML scraping...');
      items = await fetchMediaFromHTML(url);
      if (items) console.log(`[IG] HTML scrape: found ${items.length} item(s)`);
    } catch (err) {
      console.warn('[IG] HTML scrape error:', err.message);
    }
  }

  if (!items || items.length === 0) {
    throw new Error('Не удалось скачать пост из Instagram. Попробуйте позже.');
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
