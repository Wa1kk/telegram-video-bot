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
 *   /p/CODE, /reel/CODE, /tv/CODE
 */
function extractShortcode(url) {
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Decode unicode escape sequences like \u0026 -> &
 */
function decodeUnicode(str) {
  return str.replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * Download an Instagram Reel / video post.
 */
async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Invalid Instagram URL');

  // Instagram embed page is available without login and usually contains the video URL
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  const response = await fetch(embedUrl, { headers: HEADERS });

  if (!response.ok) {
    throw new Error(`Instagram returned HTTP ${response.status}. The post may be private or deleted.`);
  }

  const html = await response.text();

  // Patterns to find video URL in the embed page
  const videoPatterns = [
    /video_url":"(https:[^"]+\.mp4[^"]*?)"/,
    /"src":"(https:\/\/[^"]+\.mp4[^"]*?)"/,
    /property="og:video(?::url)?" content="([^"]+)"/,
  ];

  let videoUrl = null;
  for (const pattern of videoPatterns) {
    const m = html.match(pattern);
    if (m) {
      videoUrl = decodeUnicode(m[1]);
      break;
    }
  }

  if (!videoUrl) {
    throw new Error(
      'Could not find the video URL in this Instagram post. The post may be private, age-restricted, or Instagram has updated their page structure.'
    );
  }

  // Try to grab a description from the embed page
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

  // Stream the video
  const videoResponse = await fetch(videoUrl, {
    headers: {
      ...HEADERS,
      Referer: 'https://www.instagram.com/',
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
