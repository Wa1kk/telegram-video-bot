'use strict';

const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Invidious instances (fallback)
const INVIDIOUS_INSTANCES = [
  'https://inv.thepixora.com',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
];

// Cobalt instances (fallback)
const COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

// Path to bundled yt-dlp binary (last fallback)
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

// ── Method 1: YouTube Innertube API ──────────────────────────────────
// This is the same API that YouTube's own web player uses in the browser.
// It works from serverless environments because it's designed for web clients.

const INNERTUBE_CLIENTS = [
  {
    name: 'WEB',
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240531.00.00',
        hl: 'ru',
        gl: 'RU',
      },
    },
  },
  {
    name: 'MWEB',
    context: {
      client: {
        clientName: 'MWEB',
        clientVersion: '2.20240531.00.00',
        hl: 'ru',
        gl: 'RU',
      },
    },
  },
  {
    name: 'ANDROID',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '19.29.37',
        androidSdkVersion: 30,
        hl: 'ru',
        gl: 'RU',
      },
    },
  },
];

/**
 * Try getting video stream via YouTube Innertube /player API.
 * Returns { stream, caption } or throws.
 */
async function tryInnertube(videoId, clientConfig) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
    },
    body: JSON.stringify({
      context: clientConfig.context,
      videoId,
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          autoCaptionsDefaultOn: false,
          autonavState: 'STATE_NONE',
          html5Preference: 'HTML5_PREF_WANTS',
          signatureTimestamp: Date.now(),
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    timeout: 15000,
  });

  if (!res.ok) {
    throw new Error(`Innertube HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.playabilityStatus?.status !== 'OK') {
    const reason = data.playabilityStatus?.reason || data.playabilityStatus?.messages?.join(', ') || 'Unknown';
    throw new Error(`Innertube: ${reason}`);
  }

  const streamingData = data.streamingData;
  if (!streamingData) {
    throw new Error('Innertube: no streamingData in response');
  }

  // Prefer combined formats (video+audio) — these are in "formats"
  const formats = streamingData.formats || [];
  // Adaptive formats (video-only or audio-only) — in "adaptiveFormats"
  const adaptiveFormats = streamingData.adaptiveFormats || [];

  // Try combined format first (simpler, no muxing needed)
  const combinedMp4 = formats
    .filter(f => f.mimeType && f.mimeType.startsWith('video/mp4'))
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .find(f => (f.height || 0) <= 720)
    || formats.find(f => f.mimeType && f.mimeType.startsWith('video/mp4'))
    || formats[0];

  if (combinedMp4 && combinedMp4.url) {
    const meta = {
      title: data.videoDetails?.title || '',
      authorName: data.videoDetails?.author || '',
      authorUrl: data.videoDetails?.channelId ? `https://www.youtube.com/channel/${data.videoDetails.channelId}` : '',
      description: (data.videoDetails?.shortDescription || '').substring(0, 500),
    };

    const downloaded = await downloadToTmp(combinedMp4.url);
    return { stream: downloaded, caption: buildCaption(meta) };
  }

  // If no combined format, try adaptive: get best video + best audio
  const videoOnly = adaptiveFormats
    .filter(f => f.mimeType && f.mimeType.startsWith('video/mp4') && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .find(f => (f.height || 0) <= 720)
    || adaptiveFormats.filter(f => f.mimeType && f.mimeType.startsWith('video/mp4') && f.height)[0];

  // For adaptive formats, try video-only URL (Shorts are short enough that video-only often works)
  if (videoOnly && videoOnly.url) {
    const meta = {
      title: data.videoDetails?.title || '',
      authorName: data.videoDetails?.author || '',
      authorUrl: data.videoDetails?.channelId ? `https://www.youtube.com/channel/${data.videoDetails.channelId}` : '',
      description: (data.videoDetails?.shortDescription || '').substring(0, 500),
    };

    const downloaded = await downloadToTmp(videoOnly.url);
    return { stream: downloaded, caption: buildCaption(meta) };
  }

  throw new Error('Innertube: no downloadable stream found');
}

// ── Method 2: Invidious ──────────────────────────────────────────────

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

  const formatStreams = data.formatStreams || [];
  const bestFormat = formatStreams
    .filter(s => s.type && s.type.startsWith('video/mp4'))
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
    .find(s => parseInt(s.quality) <= 720)
    || formatStreams.find(s => s.type && s.type.startsWith('video/mp4'))
    || formatStreams[0];

  if (!bestFormat || !bestFormat.url) {
    throw new Error('No suitable stream found in Invidious response');
  }

  const meta = {
    title: data.title || '',
    authorName: data.author || '',
    authorUrl: data.authorUrl || '',
    description: (data.description || '').substring(0, 500),
  };

  const downloaded = await downloadToTmp(bestFormat.url);
  return { stream: downloaded, caption: buildCaption(meta) };
}

// ── Method 3: Cobalt ─────────────────────────────────────────────────

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

  const videoUrl = data.url;
  if (!videoUrl) throw new Error('No video URL in cobalt response');

  return videoUrl;
}

// ── Method 4: yt-dlp binary ──────────────────────────────────────────

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

// ── Main entry point ─────────────────────────────────────────────────

async function getYouTubeVideo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const errors = [];

  // 1. Try Innertube API (same as YouTube web player — no auth needed)
  for (const client of INNERTUBE_CLIENTS) {
    try {
      console.log(`[YT] Trying Innertube (${client.name})...`);
      return await tryInnertube(videoId, client);
    } catch (err) {
      console.warn(`[YT] Innertube (${client.name}) failed: ${err.message}`);
      errors.push(`Innertube (${client.name}): ${err.message}`);
    }
  }

  // 2. Try Invidious instances
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`[YT] Trying Invidious: ${instance}`);
      return await tryInvidiousInstance(instance, videoId);
    } catch (err) {
      console.warn(`[YT] Invidious ${instance} failed: ${err.message}`);
      errors.push(`Invidious ${instance}: ${err.message}`);
    }
  }

  // 3. Try Cobalt instances
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

  // 4. Fallback: yt-dlp binary (with optional cookies)
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
