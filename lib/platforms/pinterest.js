'use strict';

const fetch = require('node-fetch');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Decode unicode escapes and URL-safe characters in Pinterest JSON
 */
function clean(str) {
  return str
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '');
}

/**
 * Download a Pinterest video pin.
 * Supports: pin.it short links and pinterest.com/pin/ URLs
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

  let videoUrl = null;
  let description = '';

  // Pinterest embeds all data as JSON in a <script id="__PWS_DATA__"> tag
  const pwsMatch = html.match(/<script id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (pwsMatch) {
    try {
      const data = JSON.parse(pwsMatch[1]);

      // Path: props.initialReduxState.pins
      const pins = data?.props?.initialReduxState?.pins;
      if (pins) {
        for (const pin of Object.values(pins)) {
          // Try video_list (standard video pin)
          const videoList = pin?.videos?.video_list;
          if (videoList) {
            // Quality preference: V_720P -> V_480P -> V_HLS -> first available
            const preferred = ['V_720P', 'V_480P', 'V_EXP7', 'V_CLIP'];
            for (const q of preferred) {
              if (videoList[q]?.url) {
                videoUrl = videoList[q].url;
                break;
              }
            }
            // Fallback: take any available quality
            if (!videoUrl) {
              const firstKey = Object.keys(videoList)[0];
              videoUrl = videoList[firstKey]?.url;
            }
          }

          // Description
          if (!description && pin?.description) {
            description = String(pin.description).substring(0, 500);
          }

          if (videoUrl) break;
        }
      }
    } catch (_) {
      // JSON parse failed, fall through to regex patterns
    }
  }

  // Fallback regex patterns for video URL
  if (!videoUrl) {
    const patterns = [
      /"V_720P":\{"url":"([^"]+)"/,
      /"V_480P":\{"url":"([^"]+)"/,
      /"video_url":"([^"]+)"/,
      /property="og:video" content="([^"]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        videoUrl = clean(m[1]);
        break;
      }
    }
  }

  if (!videoUrl) {
    throw new Error(
      'Could not find video in this Pinterest pin. Make sure the pin contains a video (not just an image).'
    );
  }

  // Fallback title from <title>
  if (!description) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) {
      description = titleMatch[1].replace(/ \| Pinterest$/, '').trim();
    }
  }

  const videoResponse = await fetch(clean(videoUrl), {
    headers: {
      ...HEADERS,
      Referer: 'https://www.pinterest.com/',
    },
  });

  if (!videoResponse.ok) {
    throw new Error(`Could not download Pinterest video (HTTP ${videoResponse.status})`);
  }

  return {
    stream: videoResponse.body,
    title: 'Pinterest Video',
    description,
  };
}

module.exports = { getPinterestVideo };
