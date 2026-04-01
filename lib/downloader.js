'use strict';

const { getYouTubeVideo } = require('./platforms/youtube');
const { getInstagramVideo } = require('./platforms/instagram');
const { getPinterestVideo } = require('./platforms/pinterest');

/**
 * Detect which platform a URL belongs to.
 * Returns 'youtube' | 'instagram' | 'pinterest' | null
 */
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/instagram\.com/.test(url)) return 'instagram';
  if (/pinterest\.|pin\.it/.test(url)) return 'pinterest';
  return null;
}

/**
 * Download a video from a supported platform URL.
 * @returns {{ stream: import('stream').Readable, title: string, description: string }}
 */
async function downloadVideo(url, platform) {
  switch (platform) {
    case 'youtube':
      return getYouTubeVideo(url);
    case 'instagram':
      return getInstagramVideo(url);
    case 'pinterest':
      return getPinterestVideo(url);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

module.exports = { detectPlatform, downloadVideo };
