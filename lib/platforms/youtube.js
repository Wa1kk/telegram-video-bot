'use strict';

const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Invidious instances — open-source YouTube frontends that handle auth server-side.
// No user cookies needed. API: /api/v1/videos/{videoId}
const INVIDIOUS_INSTANCES = [
  'https://inv.thepixora.com',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
];

// Cobalt instances that support YouTube.
// Order matters — first working instance wins.
const COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

// Path to bundled yt-dlp binary (fallback when Cobalt fails)
const YT_DLP = __dirname + '/../../bin/yt-dlp';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Extract video ID from YouTube URL.
 */
function extractVideoId(url) {
  const m = url.match(
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

/**
 * Fetch video metadata from YouTube oEmbed (always works, no auth).
 */
async function fetchMetadata(videoId) {
  const meta = { title: '', authorName: '', authorUrl: '', description: '' };

  // 1. oEmbed — always works, gives title + author
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { 'User-Agent': UA }, timeout: 8000 }
    );
    if (res.ok) {
      const data = await res.json();
      meta.title = data.title || '';
      meta.authorName = data.author_name || '';
      meta.authorUrl = data.author_url || '';
    }
  } catch {}

  // 2. Scrape description from the YouTube page HTML (try shorts + watch)
  for (const pageUrl of [
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]) {
    if (meta.description) break;
    try {
      const res = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5' },
        timeout: 10000,
      });
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/"expandableVideoDescriptionBodyRenderer":\{"descriptionBodyText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
      if (m) {
        meta.description = JSON.parse(`"${m[1]}"`);
      }
    } catch {}
  }

  return meta;
}

/**
 * Escape HTML special chars for Telegram HTML parse_mode.
 */
function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build rich caption (HTML format for Telegram).
 */
function buildCaption(meta) {
  const authorLink = meta.authorUrl
    ? `<a href="${meta.authorUrl}">${esc(meta.authorName)}</a>`
    : esc(meta.authorName);

  const lines = [
    `👤 ${authorLink}`,
    '',
    `🔗 ${esc(meta.title)}`,
  ];

  if (meta.description) {
    lines.push('', `📝 Описание:`, `<blockquote>${esc(meta.description)}</blockquote>`);
  }

  let text = lines.join('\n');
  if (text.length > 1024) text = text.substring(0, 1021) + '...';
  return text;
}

/**
 * Try downloading via a single Cobalt instance.
 * Returns { videoUrl } or throws.
 */
async function tryCobaltInstance(instanceUrl, youtubeUrl) {
  const res = await fetch(instanceUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: youtubeUrl,
      videoQuality: '720',
    }),
    timeout: 15000,
  });

  const data = await res.json();

  if (data.status === 'error') {
    const code = data.error?.code || 'unknown';
    throw new Error(`Cobalt error: ${code}`);
  }

  // Cobalt returns either a direct URL or a tunnel URL
  const videoUrl = data.url;
  if (!videoUrl) throw new Error('No video URL in cobalt response');

  return videoUrl;
}

/**
 * Download video from URL to /tmp, return readable stream.
 */
async function downloadToTmp(videoUrl) {
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  const response = await fetch(videoUrl, {
    headers: { 'User-Agent': UA },
    timeout: 120000,
  });

  if (!response.ok) {
    throw new Error(`Video download failed (HTTP ${response.status})`);
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
    throw new Error('Downloaded file is empty');
  }
  console.log(`[YT] Video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return stream;
}

/**
 * Write YT_COOKIES env var (Netscape cookie format) to a temp file.
 * Returns the file path, or null if no cookies configured.
 */
function writeCookieFile() {
  const raw = process.env.YT_COOKIES;
  if (!raw) return null;
  const id = crypto.randomBytes(6).toString('hex');
  const cookieFile = `/tmp/yt_cookies_${id}.txt`;
  fs.writeFileSync(cookieFile, raw.trim() + '\n');
  return cookieFile;
}

async function downloadViaYtDlp(url) {
  const { execFile } = require('child_process');
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  const videoId = extractVideoId(url);
  const cookieFile = writeCookieFile();

  const args = [
    '--no-warnings',
    '--format', 'best[height<=720]',
    '--merge-output-format', 'mp4',
    '--output', outFile,
    '--remux-video', 'mp4',
  ];

  if (cookieFile) {
    args.push('--cookies', cookieFile);
  }

  args.push(url);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        YT_DLP,
        args,
        { timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = stderr?.trim() || err.message;
            reject(new Error(msg));
            return;
          }
          resolve();
        }
      );
    });
  } finally {
    if (cookieFile) fs.unlink(cookieFile, () => {});
  }

  if (!fs.existsSync(outFile)) {
    throw new Error('yt-dlp did not produce output file');
  }
  const stat = fs.statSync(outFile);
  if (stat.size === 0) {
    fs.unlinkSync(outFile);
    throw new Error('yt-dlp: downloaded file is empty');
  }
  console.log(`[YT] yt-dlp video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const [meta] = await Promise.all([
    videoId ? fetchMetadata(videoId) : Promise.resolve({ title: '', authorName: '', authorUrl: '', description: '' }),
  ]);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return { stream, caption: buildCaption(meta) };
}

/**
 * Try downloading via a single Invidious instance.
 * Invidious is an open-source YouTube frontend that handles auth server-side.
 * Returns { stream, caption } or throws.
 */
async function tryInvidiousInstance(instanceUrl, videoId) {
  const res = await fetch(`${instanceUrl}/api/v1/videos/${videoId}`, {
    headers: { 'User-Agent': UA },
    timeout: 15000,
  });

  if (!res.ok) {
    throw new Error(`Invidious HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Invidious: ${data.message || data.error}`);
  }

  // Invidious formatStreams: pre-muxed (video+audio), lower quality
  const formatStreams = data.formatStreams || [];
  // Prefer mp4 <=720p
  const bestFormat = formatStreams
    .filter(s => s.type && s.type.startsWith('video/mp4'))
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
    .find(s => parseInt(s.quality) <= 720)
    || formatStreams.find(s => s.type && s.type.startsWith('video/mp4'))
    || formatStreams[0];

  if (!bestFormat || !bestFormat.url) {
    throw new Error('No suitable stream found in Invidious response');
  }

  // Build metadata from Invidious response
  const meta = {
    title: data.title || '',
    authorName: data.author || '',
    authorUrl: data.authorUrl || '',
    description: data.description || '',
  };

  const downloaded = await downloadToTmp(bestFormat.url);
  return { stream: downloaded, caption: buildCaption(meta) };
}

async function getYouTubeVideo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const errors = [];

  // 1. Try Invidious instances (no auth needed)
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`[YT] Trying Invidious: ${instance}`);
      return await tryInvidiousInstance(instance, videoId);
    } catch (err) {
      console.warn(`[YT] Invidious ${instance} failed: ${err.message}`);
      errors.push(`Invidious ${instance}: ${err.message}`);
    }
  }

  // 2. Try Cobalt instances
  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`[YT] Trying cobalt: ${instance}`);
      const videoUrl = await tryCobaltInstance(instance, youtubeUrl);

      const [meta, stream] = await Promise.all([
        fetchMetadata(videoId),
        downloadToTmp(videoUrl),
      ]);

      return {
        stream,
        caption: buildCaption(meta),
      };
    } catch (err) {
      console.warn(`[YT] ${instance} failed: ${err.message}`);
      errors.push(`${instance}: ${err.message}`);
    }
  }

  // 3. Fallback: yt-dlp binary (with optional cookies)
  try {
    console.log('[YT] Trying yt-dlp...');
    return await downloadViaYtDlp(url);
  } catch (err) {
    console.warn(`[YT] yt-dlp failed: ${err.message}`);
    errors.push(`yt-dlp: ${err.message}`);
  }

  throw new Error(
    `Не удалось скачать видео с YouTube.\n${errors.join('\n')}`
  );
}

module.exports = { getYouTubeVideo };
