'use strict';

const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Cobalt instances that support YouTube (tested & working).
// Order matters — first working instance wins.
const COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

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
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { 'User-Agent': UA }, timeout: 8000 }
    );
    if (res.ok) {
      const data = await res.json();
      return { title: data.title || '', author: data.author_name || '' };
    }
  } catch {}
  return { title: '', author: '' };
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
 * Download a YouTube video via Cobalt API instances.
 * Returns { stream, title, description }.
 */
async function getYouTubeVideo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const errors = [];

  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`[YT] Trying cobalt: ${instance}`);
      const videoUrl = await tryCobaltInstance(instance, youtubeUrl);

      // Fetch metadata in parallel with video download
      const [meta, stream] = await Promise.all([
        fetchMetadata(videoId),
        downloadToTmp(videoUrl),
      ]);

      return {
        stream,
        title: meta.title,
        description: meta.author ? `Автор: ${meta.author}` : '',
      };
    } catch (err) {
      console.warn(`[YT] ${instance} failed: ${err.message}`);
      errors.push(`${instance}: ${err.message}`);
    }
  }

  throw new Error(
    `Не удалось скачать видео с YouTube.\n${errors.join('\n')}`
  );
}

module.exports = { getYouTubeVideo };
