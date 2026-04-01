'use strict';

const ytdl = require('@distube/ytdl-core');

/**
 * Download a YouTube or YouTube Shorts video.
 * Returns a Node.js Readable stream + metadata.
 */
async function getYouTubeVideo(url) {
  const info = await ytdl.getInfo(url);
  const details = info.videoDetails;

  const title = details.title;
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
    throw new Error('No suitable video format found for this YouTube video.');
  }

  const stream = ytdl.downloadFromInfo(info, { format });

  return { stream, title, description };
}

module.exports = { getYouTubeVideo };
