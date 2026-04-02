'use strict';

const fetch = require('node-fetch');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
};

/**
 * Decode unicode escapes and URL-safe characters in Pinterest JSON.
 */
function clean(str) {
  return str
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '');
}

/**
 * Parse pin data from the __PWS_DATA__ script tag.
 * Returns the first pin object or null.
 */
function parsePinData(html) {
  const pwsMatch = html.match(/<script id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!pwsMatch) return null;

  try {
    const data = JSON.parse(pwsMatch[1]);
    const pins = data?.props?.initialReduxState?.pins;
    if (!pins) return null;
    return Object.values(pins)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Extract best video URL from pin data.
 */
function extractVideoUrl(pin) {
  const videoList = pin?.videos?.video_list;
  if (!videoList) return null;

  const preferred = ['V_720P', 'V_480P', 'V_EXP7', 'V_CLIP'];
  for (const q of preferred) {
    if (videoList[q]?.url) return videoList[q].url;
  }
  // Fallback: first available
  const firstKey = Object.keys(videoList)[0];
  return videoList[firstKey]?.url || null;
}

/**
 * Extract best image URL from pin data.
 */
function extractImageUrl(pin, html) {
  // 1. From pin data: check multiple known fields
  // closeup_images / closeup_unified_description often has the real image
  const candidateSets = [
    pin?.closeup_images,
    pin?.images,
    pin?.image_medium_size_pixels && { main: pin.image_medium_size_pixels },
  ].filter(Boolean);

  for (const images of candidateSets) {
    if (images.orig?.url) return images.orig.url;
    // Pick largest by width
    let best = null;
    for (const img of Object.values(images)) {
      if (img?.url && (!best || (img.width || 0) > (best.width || 0))) best = img;
    }
    if (best?.url) return best.url;
  }

  // 2. Look for pin image URL in JSON data within HTML (more reliable than og:image)
  // Pattern: "url":"https://i.pinimg.com/originals/XX/XX/XX/filename.ext"
  const jsonImgMatch = html.match(/"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/);
  if (jsonImgMatch) return clean(jsonImgMatch[1]);

  // 3. og:image — usually reliable for the pin itself
  const ogMatch = html.match(/property="og:image"\s*content="([^"]+)"/);
  if (ogMatch) {
    const ogUrl = clean(ogMatch[1]);
    // Upgrade to originals if it's a sized version
    return ogUrl.replace(/\/(?:236x|474x|736x)\//, '/originals/');
  }

  return null;
}

/**
 * Extract description from pin data or HTML.
 */
function extractDescription(pin, html) {
  if (pin?.description) return String(pin.description).substring(0, 500);
  // Title from pin data
  if (pin?.title) return String(pin.title).substring(0, 500);
  // Fallback: <title> tag
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) return titleMatch[1].replace(/ \| Pinterest$/, '').trim();
  return '';
}

/**
 * Download a Pinterest pin (video or photo).
 * Returns { stream, caption, type: 'video' | 'photo', filename }.
 */
async function getPinterestVideo(url) {
  // Expand short links (pin.it)
  if (/pin\.it/.test(url)) {
    const r = await fetch(url, { redirect: 'follow', headers: HEADERS });
    url = r.url;
  }

  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`Pinterest returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const pin = parsePinData(html);
  let description = extractDescription(pin, html);

  // Fallback: description from meta tag
  if (!description) {
    const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
    if (metaDesc) description = metaDesc[1].replace(/ \| Pinterest$/, '').trim().substring(0, 500);
  }

  // Try video first
  let videoUrl = pin ? extractVideoUrl(pin) : null;

  // Fallback regex for video
  if (!videoUrl) {
    const patterns = [
      /"V_720P":\{"url":"([^"]+)"/,
      /"V_480P":\{"url":"([^"]+)"/,
      /"video_url":"([^"]+)"/,
      /property="og:video" content="([^"]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) { videoUrl = clean(m[1]); break; }
    }
  }

  if (videoUrl) {
    // Download video
    const vidRes = await fetch(clean(videoUrl), {
      headers: { ...HEADERS, Referer: 'https://www.pinterest.com/' },
    });
    if (!vidRes.ok) throw new Error(`Pinterest video download failed (HTTP ${vidRes.status})`);

    return { stream: vidRes.body, caption: '', type: 'video', filename: 'video.mp4' };
  }

  // No video — try image
  let imageUrl = pin ? extractImageUrl(pin, html) : null;

  // Fallback: find image in JSON strings within HTML (skip CSS background-images)
  if (!imageUrl) {
    // Only match URLs inside JSON strings (preceded by ") — not CSS url()
    const jsonImgMatches = [...html.matchAll(/"(https:\/\/i\.pinimg\.com\/(?:originals|736x)\/[a-f0-9\/]+\.\w{3,4})"/g)]
      .map(m => m[1]);
    const unique = [...new Set(jsonImgMatches)];
    const orig = unique.find(u => u.includes('/originals/'));
    imageUrl = orig || unique[0] || null;
  }
  if (!imageUrl) {
    // og:image as last resort
    const ogMatch = html.match(/property="og:image"\s*content="([^"]+)"/);
    if (ogMatch) {
      imageUrl = clean(ogMatch[1]).replace(/\/(?:236x|474x|736x)\//, '/originals/');
    }
  }

  if (!imageUrl) {
    throw new Error('Не удалось найти контент в этом пине.');
  }

  const imgRes = await fetch(clean(imageUrl), {
    headers: { ...HEADERS, Referer: 'https://www.pinterest.com/' },
  });
  if (!imgRes.ok) throw new Error(`Pinterest image download failed (HTTP ${imgRes.status})`);

  return { stream: imgRes.body, caption: '', type: 'photo', filename: 'image.jpg' };
}


module.exports = { getPinterestVideo };
