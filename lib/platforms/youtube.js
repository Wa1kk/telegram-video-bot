'use strict';

const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Download a YouTube or YouTube Shorts video.
 * Returns { stream, title, description }.
 */
async function getYouTubeVideo(url) {
  const info = await ytdl.getInfo(url);
  const details = info.videoDetails;

  const title = details.title || '';
  const description = (details.description || '').substring(0, 500);

  // Prefer progressive MP4 (video+audio in one stream)
  let format = ytdl.chooseFormat(info.formats, {
    quality: 'highestvideo',
    filter: f => f.hasVideo && f.hasAudio && f.container === 'mp4',
  });

  // Fallback: any format with both video and audio
  if (!format) {
    format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: f => f.hasVideo && f.hasAudio,
    });
  }

  if (!format) {
    throw new Error('Не найден подходящий формат видео.');
  }

  // Download to /tmp file for reliable upload to Telegram
  const id = crypto.randomBytes(6).toString('hex');
  const outFile = `/tmp/video_${id}.mp4`;

  await new Promise((resolve, reject) => {
    const dl = ytdl.downloadFromInfo(info, { format });
    const ws = fs.createWriteStream(outFile);
    dl.pipe(ws);
    dl.on('error', reject);
    ws.on('finish', resolve);
  });

  const stat = fs.statSync(outFile);
  if (stat.size === 0) {
    fs.unlinkSync(outFile);
    throw new Error('Downloaded file is empty');
  }
  console.log(`YouTube video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));

  return { stream, title, description };
}

module.exports = { getYouTubeVideo };
