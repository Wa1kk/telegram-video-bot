'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { instagramGetUrl } = require('instagram-url-direct');

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

/**
 * Detect which platform a URL belongs to.
 */
function detectPlatform(url) {
  if (/youtube\.com\/(shorts|watch)|youtu\.be\//.test(url)) return 'youtube';
  if (/instagram\.com\/(p|reel|reels|tv|share\/r|share\/reel)\//.test(url)) return 'instagram';
  if (/pinterest\.\w+\/pin\/|pin\.it\//.test(url)) return 'pinterest';
  return null;
}

/**
 * Get yt-dlp binary path (for YouTube/Pinterest).
 */
async function getYtdlpPath() {
  const tmpBin = '/tmp/yt-dlp';
  if (fs.existsSync(tmpBin)) return tmpBin;

  const bundled = path.join(__dirname, '..', 'bin', 'yt-dlp');
  if (fs.existsSync(bundled)) {
    fs.copyFileSync(bundled, tmpBin);
    fs.chmodSync(tmpBin, 0o755);
    return tmpBin;
  }

  console.log('Downloading yt-dlp binary...');
  const res = await fetch(YT_DLP_URL, { redirect: 'follow' });
  const buffer = await res.buffer();
  fs.writeFileSync(tmpBin, buffer);
  fs.chmodSync(tmpBin, 0o755);
  return tmpBin;
}

/**
 * Download Instagram video using instagram-url-direct (no auth needed).
 */
async function downloadInstagram(url) {
  const result = await instagramGetUrl(url);

  if (!result.url_list || result.url_list.length === 0) {
    throw new Error('Не удалось получить ссылку на видео. Пост может быть приватным.');
  }

  const videoUrl = result.url_list[0];
  const caption = result.post_info?.caption || '';
  const author = result.post_info?.owner_username || '';
  const title = author ? `@${author}` : 'Instagram';

  // Download the video file
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  const response = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.instagram.com/',
    },
  });

  if (!response.ok) {
    throw new Error(`Не удалось скачать видео (HTTP ${response.status})`);
  }

  // Write to temp file
  const fileStream = fs.createWriteStream(outFile);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
  });

  const stat = fs.statSync(outFile);
  if (stat.size === 0) throw new Error('Downloaded file is empty');
  console.log(`Instagram video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));

  return { stream, title, description: caption.substring(0, 500) };
}

/**
 * Download YouTube/Pinterest video using yt-dlp.
 */
async function downloadWithYtdlp(url) {
  const bin = await getYtdlpPath();
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  try {
    // Get metadata
    const infoRaw = execFileSync(bin, [
      '--no-warnings', '--dump-json', '--no-playlist', url,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoRaw.toString());
    const title = info.title || '';
    const description = (info.description || '').substring(0, 500);

    // Download video
    execFileSync(bin, [
      '--no-warnings', '--no-playlist',
      '-f', 'best[ext=mp4][filesize<50M]/best[ext=mp4]/best[filesize<50M]/best',
      '-o', outFile,
      '--no-part', '--no-mtime', '--no-check-certificates',
      url,
    ], { timeout: 240000, maxBuffer: 1024 * 1024 });

    const stat = fs.statSync(outFile);
    if (stat.size === 0) throw new Error('Downloaded file is empty');
    console.log(`Downloaded video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    const stream = fs.createReadStream(outFile);
    stream.on('close', () => fs.unlink(outFile, () => {}));

    return { stream, title, description };
  } catch (err) {
    fs.unlink(outFile, () => {});
    throw err;
  }
}

/**
 * Main download dispatcher.
 */
async function downloadVideo(url, platform) {
  if (platform === 'instagram') {
    return downloadInstagram(url);
  }
  return downloadWithYtdlp(url);
}

module.exports = { detectPlatform, downloadVideo };
