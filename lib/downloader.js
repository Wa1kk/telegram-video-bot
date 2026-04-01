'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { getInstagramVideo } = require('./platforms/instagram');
const { getYouTubeVideo } = require('./platforms/youtube');

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
 * Get yt-dlp binary path (for Pinterest).
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
 * Download Pinterest video using yt-dlp.
 */
async function downloadWithYtdlp(url) {
  const bin = await getYtdlpPath();
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  try {
    const infoRaw = execFileSync(bin, [
      '--no-warnings', '--dump-json', '--no-playlist', url,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoRaw.toString());
    const title = info.title || '';
    const description = (info.description || '').substring(0, 500);

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
  switch (platform) {
    case 'instagram':
      return getInstagramVideo(url);
    case 'youtube':
      return getYouTubeVideo(url);
    case 'pinterest':
      return downloadWithYtdlp(url);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

module.exports = { detectPlatform, downloadVideo };
