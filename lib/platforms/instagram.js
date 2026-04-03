'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

// ── URL parsing ──

function extractShortcode(url) {
  const share = url.match(/instagram\.com\/share\/(?:r|reel)\/([A-Za-z0-9_-]+)/);
  if (share) return share[1];
  const direct = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return direct ? direct[1] : null;
}

// ── Cobalt API (primary method) ──

async function fetchViaCobalt(url) {
  const errors = [];
  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`[IG] Cobalt: ${instance}`);
      const res = await fetch(instance, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
        timeout: 30000,
      });

      const data = await res.json();
      console.log(`[IG] Cobalt response status: ${data.status}`);

      if (data.status === 'error') {
        errors.push(`${instance}: ${data.error?.code || 'unknown error'}`);
        continue;
      }

      // Single media (redirect/stream)
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

      errors.push(`${instance}: unexpected response`);
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
      console.warn(`[IG] Cobalt ${instance} failed: ${err.message}`);
    }
  }
  console.error(`[IG] All Cobalt instances failed:\n${errors.join('\n')}`);
  return null;
}

// ── Metadata scraping (for caption) ──

async function scrapeMetadata(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      redirect: 'follow',
      timeout: 10000,
    });
    if (!res.ok) return null;
    const html = await res.text();

    let username = '', fullName = '', description = '';

    // Try to extract from JSON in page
    const ownerMatch = html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
    if (ownerMatch) username = ownerMatch[1];

    const nameMatch = html.match(/"full_name"\s*:\s*"([^"]+)"/);
    if (nameMatch) fullName = nameMatch[1];

    const captionMatch = html.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (captionMatch) {
      try { description = JSON.parse(`"${captionMatch[1]}"`); } catch { description = captionMatch[1]; }
    }

    // Fallback to og/meta tags
    if (!username) {
      const ogAuthor = html.match(/content="@([^"]+)" .*?property="og:description"/);
      if (ogAuthor) username = ogAuthor[1];
    }

    if (username || fullName) {
      return { username, fullName: fullName || username, description };
    }
  } catch {}
  return null;
}

// ── Formatting helpers ──

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCaption(meta) {
  if (!meta) return '';
  const profileUrl = `https://www.instagram.com/${meta.username}/`;
  const name = esc(meta.fullName || meta.username);
  const lines = [`👤 <a href="${profileUrl}">${name}</a>`];

  if (meta.description) {
    let desc = esc(meta.description);
    if (desc.length > 800) desc = desc.substring(0, 800) + '...';
    lines.push('', `<blockquote>${desc}</blockquote>`);
  }

  let text = lines.join('\n');
  if (text.length > 1024) text = text.substring(0, 1021) + '...';
  return text;
}

// ── Download helper ──

async function downloadToTmp(fileUrl, ext = 'mp4') {
  const id = crypto.randomBytes(6).toString('hex');
  const tmpDir = process.platform === 'win32' ? process.env.TEMP || 'C:\\Temp' : '/tmp';
  const outFile = `${tmpDir}/ig_${id}.${ext}`;

  const response = await fetch(fileUrl, {
    headers: { 'User-Agent': UA },
    timeout: 120000,
  });

  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }

  const fileStream = fs.createWriteStream(outFile);
  await new Promise((resolve, reject) => {
    fileStream.on('error', reject);
    response.body.on('error', reject);
    response.body.pipe(fileStream);
    fileStream.on('finish', resolve);
  });

  const stat = fs.statSync(outFile);
  if (stat.size === 0) {
    fs.unlinkSync(outFile);
    throw new Error('Downloaded file is empty');
  }
  console.log(`[IG] Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)} MB (${ext})`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return stream;
}

// ── Main entry point ──

async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  // Get media URLs via Cobalt
  const items = await fetchViaCobalt(url);
  if (!items || items.length === 0) {
    throw new Error('Не удалось скачать из Instagram. Все серверы недоступны.');
  }

  // Get metadata for caption (non-blocking, don't fail if it doesn't work)
  const meta = await scrapeMetadata(url).catch(() => null);
  const caption = buildCaption(meta);

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
