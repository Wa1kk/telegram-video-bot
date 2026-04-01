'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

/**
 * Detect which platform a URL belongs to.
 * Returns 'youtube' | 'instagram' | 'pinterest' | null
 */
function detectPlatform(url) {
  if (/youtube\.com\/(shorts|watch)|youtu\.be\//.test(url)) return 'youtube';
  if (/instagram\.com\/(p|reel|reels|tv|share\/r|share\/reel)\//.test(url)) return 'instagram';
  if (/pinterest\.\w+\/pin\/|pin\.it\//.test(url)) return 'pinterest';
  return null;
}

/**
 * Get yt-dlp binary path, downloading it to /tmp on first use (Vercel runtime).
 * In local dev, expects it in ./bin/yt-dlp or on PATH.
 */
async function getYtdlpPath() {
  // On Vercel (Linux): binary is bundled in the deployment at bin/yt-dlp
  const bundled = path.join(__dirname, '..', 'bin', 'yt-dlp');
  if (fs.existsSync(bundled)) {
    // Copy to /tmp and make executable (deployment files may be read-only)
    const tmpBin = '/tmp/yt-dlp';
    if (!fs.existsSync(tmpBin)) {
      fs.copyFileSync(bundled, tmpBin);
      fs.chmodSync(tmpBin, 0o755);
    }
    return tmpBin;
  }

  // Fallback: download to /tmp
  const tmpBin = '/tmp/yt-dlp';
  if (fs.existsSync(tmpBin)) return tmpBin;

  console.log('Downloading yt-dlp binary...');
  const res = await fetch(YT_DLP_URL, { redirect: 'follow' });
  const buffer = await res.buffer();
  fs.writeFileSync(tmpBin, buffer);
  fs.chmodSync(tmpBin, 0o755);
  console.log(`yt-dlp downloaded: ${buffer.length} bytes`);

  return tmpBin;
}

/**
 * Run yt-dlp and return parsed JSON output.
 */
function runYtdlp(binPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, args, {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Download a video from any supported URL using yt-dlp.
 * Returns { stream, title, description }.
 */
async function downloadVideo(url, _platform) {
  const bin = await getYtdlpPath();

  // Step 1: Get video metadata
  const infoJson = await runYtdlp(bin, [
    '--no-warnings',
    '--dump-json',
    '--no-playlist',
    url,
  ]);

  const info = JSON.parse(infoJson);
  const title = info.title || '';
  const description = (info.description || '').substring(0, 500);

  // Step 2: Stream the video to stdout
  // Pick a format with both video+audio, mp4 preferred, max 50MB for Telegram
  const stream = spawn(bin, [
    '--no-warnings',
    '--no-playlist',
    '-f', 'best[ext=mp4][filesize<50M]/best[ext=mp4]/best[filesize<50M]/best',
    '-o', '-',                  // output to stdout
    '--no-part',
    '--no-mtime',
    url,
  ], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 240000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  stream.stderr.on('data', d => {
    console.log('[yt-dlp]', d.toString().trim());
  });

  return { stream: stream.stdout, title, description };
}

module.exports = { detectPlatform, downloadVideo };
