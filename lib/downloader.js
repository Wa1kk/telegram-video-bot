'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

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
 * Get yt-dlp binary path. Bundled in bin/ and copied to /tmp for execution.
 */
async function getYtdlpPath() {
  const tmpBin = '/tmp/yt-dlp';
  if (fs.existsSync(tmpBin)) return tmpBin;

  // Copy bundled binary to /tmp (Vercel deployment files are read-only)
  const bundled = path.join(__dirname, '..', 'bin', 'yt-dlp');
  if (fs.existsSync(bundled)) {
    fs.copyFileSync(bundled, tmpBin);
    fs.chmodSync(tmpBin, 0o755);
    return tmpBin;
  }

  // Fallback: download at runtime
  console.log('Downloading yt-dlp binary...');
  const res = await fetch(YT_DLP_URL, { redirect: 'follow' });
  const buffer = await res.buffer();
  fs.writeFileSync(tmpBin, buffer);
  fs.chmodSync(tmpBin, 0o755);
  console.log(`yt-dlp downloaded: ${buffer.length} bytes`);
  return tmpBin;
}

/**
 * Download a video from any supported URL using yt-dlp.
 * Downloads to /tmp file, then returns a readable stream + metadata.
 */
async function downloadVideo(url, _platform) {
  const bin = await getYtdlpPath();
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  try {
    // Step 1: Get video metadata
    const infoRaw = execFileSync(bin, [
      '--no-warnings',
      '--dump-json',
      '--no-playlist',
      url,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoRaw.toString());
    const title = info.title || '';
    const description = (info.description || '').substring(0, 500);

    // Step 2: Download video to temp file
    execFileSync(bin, [
      '--no-warnings',
      '--no-playlist',
      '-f', 'best[ext=mp4][filesize<50M]/best[ext=mp4]/best[filesize<50M]/best',
      '-o', outFile,
      '--no-part',
      '--no-mtime',
      '--no-check-certificates',
      url,
    ], { timeout: 240000, maxBuffer: 1024 * 1024 });

    // Verify file exists and is not empty
    const stat = fs.statSync(outFile);
    if (stat.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    console.log(`Downloaded video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    // Return a read stream (will be consumed by telegram.sendVideo)
    const stream = fs.createReadStream(outFile);

    // Clean up temp file after stream is consumed
    stream.on('close', () => {
      fs.unlink(outFile, () => {});
    });

    return { stream, title, description };
  } catch (err) {
    // Clean up on error
    fs.unlink(outFile, () => {});
    throw err;
  }
}

module.exports = { detectPlatform, downloadVideo };
