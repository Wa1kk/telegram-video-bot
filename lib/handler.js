'use strict';

const { sendMessage, editMessage, deleteMessage, sendVideo } = require('./telegram');
const { detectPlatform, downloadVideo } = require('./downloader');

// Matches YouTube Shorts/videos, Instagram Reels/posts, Pinterest pins
const SUPPORTED_URL_RE =
  /https?:\/\/(www\.)?(youtube\.com\/(shorts|watch)|youtu\.be\/|instagram\.com\/(p|reel|reels|tv|share\/r|share\/reel)\/|([a-z]+\.)?pinterest\.(com|ru|co\.\w+|fr|de|it|es|jp|ca|au|br|se|pt|nl|at|ch|be|dk|fi|no|pl)\/pin\/|pin\.it\/)[^\s]*/gi;

/**
 * Extract all URLs from a Telegram message using entity offsets (most accurate),
 * with a regex fallback for messages without entities.
 */
function extractSupportedUrls(message) {
  const text = message.text || message.caption || '';
  const urls = [];

  if (message.entities || message.caption_entities) {
    const entities = message.entities || message.caption_entities || [];
    for (const e of entities) {
      if (e.type === 'url') {
        const url = text.substring(e.offset, e.offset + e.length);
        if (detectPlatform(url)) urls.push(url);
      }
    }
  }

  if (urls.length === 0) {
    // Fallback: regex scan
    const matches = text.matchAll(SUPPORTED_URL_RE);
    for (const m of matches) {
      urls.push(m[0]);
    }
  }

  return urls;
}

/**
 * Build a Telegram caption from title + description.
 * Telegram captions are limited to 1024 chars.
 */
function buildCaption(title, description) {
  const parts = [];
  if (title) parts.push(title);
  if (description && description !== title) parts.push(description);
  return parts.join('\n\n').substring(0, 1024);
}

/**
 * Friendly error message for common failure modes.
 */
function friendlyError(err) {
  const msg = err.message || '';
  if (/age.restrict/i.test(msg)) return '❌ Это видео имеет возрастные ограничения.';
  if (/private|закрыт/i.test(msg)) return '❌ Это видео приватное.';
  if (/deleted|removed/i.test(msg)) return '❌ Это видео было удалено.';
  if (/copyright/i.test(msg)) return '❌ Видео заблокировано из-за авторских прав.';
  if (/Could not find video/i.test(msg)) return `❌ ${msg}`;
  if (/Could not find the video URL/i.test(msg)) return `❌ ${msg}`;
  return `❌ Не удалось скачать видео.\n\nПричина: ${msg}`;
}

/**
 * Main handler for a Telegram update object.
 */
async function processUpdate(update) {
  const message = update.message || update.channel_post;
  if (!message) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;

  const urls = extractSupportedUrls(message);
  if (urls.length === 0) return;

  // Process the first supported URL found in the message
  const url = urls[0];
  const platform = detectPlatform(url);
  if (!platform) return;

  let statusMsgId = null;

  try {
    // Inform user we're working on it
    const statusMsg = await sendMessage(chatId, '⬇️ Скачиваю видео...', messageId);
    statusMsgId = statusMsg.message_id;

    const result = await downloadVideo(url, platform);
    // Instagram returns ready-made caption; YouTube/Pinterest return title+description
    const caption = result.caption || buildCaption(result.title, result.description);

    // Update status before the potentially-long upload
    await editMessage(chatId, statusMsgId, '📤 Загружаю в Telegram...').catch(() => {});

    await sendVideo(chatId, result.stream, 'video.mp4', caption, messageId);

    // Clean up status message
    await deleteMessage(chatId, statusMsgId).catch(() => {});
  } catch (err) {
    console.error(`[${platform}] Error processing ${url}:`, err);

    const errorText = friendlyError(err);
    await sendMessage(chatId, errorText, messageId).catch(() => {});

    if (statusMsgId) {
      await deleteMessage(chatId, statusMsgId).catch(() => {});
    }
  }
}

module.exports = { processUpdate };
