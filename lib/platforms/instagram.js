'use strict';

const fetch = require('node-fetch');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  Referer: 'https://www.instagram.com/',
};

/**
 * Extract shortcode from various Instagram URL formats:
 *   /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE, /share/r/CODE
 */
function extractShortcode(url) {
  const direct = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (direct) return direct[1];

  const share = url.match(/instagram\.com\/share\/(?:r|reel)\/([A-Za-z0-9_-]+)/);
  if (share) return share[1];

  return null;
}

/**
 * Unescape Instagram's JSON-escaped URLs:
 *   \\/ -> /
 *   \u0026 -> &
 */
function unescapeUrl(str) {
  return str
    .replace(/\\\//g, '/')
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

/**
 * Download an Instagram Reel / video post.
 */
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Invalid Instagram URL');

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  const response = await fetch(embedUrl, { headers: HEADERS });

  if (!response.ok) {
    throw new Error(`Instagram returned HTTP ${response.status}. The post may be private or deleted.`);
  }

  // Capture cookies from embed response — needed for CDN download auth
  const setCookies = response.headers.raw()['set-cookie'] || [];
  const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');

  const html = await response.text();

  let videoUrl = null;

  // Pattern 1: escaped CDN URL containing .mp4 (most common)
  // In the HTML string, slashes are escaped as \/ (literal backslash + slash)
  // Regex [\\/]+ matches both \/ sequences and plain /
  const cdnMp4 = html.match(/https?:[\\/]+[^"'\s]*?\.mp4[^"'\s]*/);
  if (cdnMp4) {
    videoUrl = cdnMp4[0].replace(/\\\//g, '/');
  }

  // Pattern 2: plain video_url in JSON
  if (!videoUrl) {
    const plain = html.match(/video_url":"(https:[^"]+)"/);
    if (plain) videoUrl = unescapeUrl(plain[1]);
  }

  // Pattern 3: og:video meta tag
  if (!videoUrl) {
    const og = html.match(/property="og:video(?::url)?" content="([^"]+)"/);
    if (og) videoUrl = og[1];
  }

  // Decode any remaining unicode escapes
  if (videoUrl) {
    videoUrl = unescapeUrl(videoUrl);
  }

  if (!videoUrl) {
    throw new Error(
      'Не удалось найти видео. Пост может быть приватным или Instagram обновил структуру страницы.'
    );
  }

  // Extract description/caption
  let description = '';
  const captionMatch = html.match(/class="[^"]*Caption[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
  if (captionMatch) {
    description = captionMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
      .substring(0, 500);
  }

  // Stream the video — pass cookies from the embed page for CDN auth
  const videoResponse = await fetch(videoUrl, {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      Referer: 'https://www.instagram.com/',
      Origin: 'https://www.instagram.com',
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    },
  });

  if (!videoResponse.ok) {
    throw new Error(`Could not download Instagram video (HTTP ${videoResponse.status})`);
  }

  return {
    stream: videoResponse.body,
    title: 'Instagram Reel',
    description,
  };
}

module.exports = { getInstagramVideo };
