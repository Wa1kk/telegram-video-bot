'use strict';

const { getInstagramVideo } = require('./platforms/instagram');
const { getYouTubeVideo } = require('./platforms/youtube');
const { getPinterestVideo } = require('./platforms/pinterest');

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
 * Main download dispatcher.
 */
async function downloadVideo(url, platform) {
  switch (platform) {
    case 'instagram':
      return getInstagramVideo(url);
    case 'youtube':
      return getYouTubeVideo(url);
    case 'pinterest':
      return getPinterestVideo(url);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

module.exports = { detectPlatform, downloadVideo };
