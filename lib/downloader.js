'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const COOKIES_PATH = '/tmp/cookies.txt';

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
  console.log(`yt-dlp downloaded: ${buffer.length} bytes`);
  return tmpBin;
}

/**
 * Write cookies file from INSTAGRAM_COOKIES env var (Netscape format, base64-encoded).
 * Returns path to cookies file or null if not configured.
 */
function ensureCookiesFile() {
  if (fs.existsSync(COOKIES_PATH)) return COOKIES_PATH;

  const cookiesB64 = process.env.INSTAGRAM_COOKIES;
  if (!cookiesB64) return null;

  const cookies = Buffer.from(cookiesB64, 'base64').toString('utf-8');
  fs.writeFileSync(COOKIES_PATH, cookies);
  return COOKIES_PATH;
}

/**
 * Build common yt-dlp args, adding --cookies if available.
 */
function baseArgs(url, platform) {
  const args = ['--no-warnings', '--no-playlist'];

  // Add cookies for platforms that need auth
  if (platform === 'instagram') {
    const cookiesFile = ensureCookiesFile();
    if (cookiesFile) {
      args.push('--cookies', cookiesFile);
    }
  }

  return args;
}

/**
 * Download a video from any supported URL using yt-dlp.
 * Downloads to /tmp file, then returns a readable stream + metadata.
 */
async function downloadVideo(url, platform) {
  const bin = await getYtdlpPath();
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  try {
    // Step 1: Get video metadata
    const infoArgs = [...baseArgs(url, platform), '--dump-json', url];
    const infoRaw = execFileSync(bin, infoArgs, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const info = JSON.parse(infoRaw.toString());
    const title = info.title || '';
    const description = (info.description || '').substring(0, 500);

    // Step 2: Download video to temp file
    const dlArgs = [
      ...baseArgs(url, platform),
      '-f', 'best[ext=mp4][filesize<50M]/best[ext=mp4]/best[filesize<50M]/best',
      '-o', outFile,
      '--no-part',
      '--no-mtime',
      '--no-check-certificates',
      url,
    ];
    execFileSync(bin, dlArgs, {
      timeout: 240000,
      maxBuffer: 1024 * 1024,
    });

    const stat = fs.statSync(outFile);
    if (stat.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    console.log(`Downloaded video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    const stream = fs.createReadStream(outFile);
    stream.on('close', () => {
      fs.unlink(outFile, () => {});
    });

    return { stream, title, description };
  } catch (err) {
    fs.unlink(outFile, () => {});

    // Friendly error for login-required
    const msg = err.message || '';
    if (/login.required|rate.limit|cookies/i.test(msg)) {
      throw new Error(
        'Instagram требует авторизацию. Владельцу бота нужно добавить cookies в настройки.'
      );
    }
    throw err;
  }
}

module.exports = { detectPlatform, downloadVideo };
