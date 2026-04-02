'use strict';

const { sendMessage, editMessage, deleteMessage, sendVideo, sendPhoto, sendMediaGroup } = require('./telegram');
const { detectPlatform, downloadVideo } = require('./downloader');

// Matches YouTube Shorts/videos, Instagram Reels/posts, Pinterest pins
const SUPPORTED_URL_RE =
  /https?:\/\/(www\.)?(youtube\.com\/(shorts|watch)|youtu\.be\/|instagram\.com\/(p|reel|reels|tv|share\/r|share\/reel)\/|([a-z]+\.)?pinterest\.(com|ru|co\.\w+|fr|de|it|es|jp|ca|au|br|se|pt|nl|at|ch|be|dk|fi|no|pl)\/pin\/|pin\.it\/|tiktok\.com\/[^\s]+|vm\.tiktok\.com\/[^\s]+)[^\s]*/gi;

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
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCaption(title, description) {
  const parts = [];
  if (title) parts.push(`<b>${esc(title)}</b>`);
  if (description && description !== title) parts.push(`<blockquote>${esc(description)}</blockquote>`);
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
  if (/Не удалось найти контент/i.test(msg)) return '❌ Не удалось найти контент в этом пине.';
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
    const statusMsg = await sendMessage(chatId, '⬇️ Скачиваю...', messageId);
    statusMsgId = statusMsg.message_id;

    const result = await downloadVideo(url, platform);
    const caption = result.caption || buildCaption(result.title, result.description);

    await editMessage(chatId, statusMsgId, '📤 Загружаю в Telegram...').catch(() => {});

    if (result.items) {
      // Carousel (multiple items)
      await sendMediaGroup(chatId, result.items, caption, messageId);
    } else if (result.type === 'photo') {
      await sendPhoto(chatId, result.stream, result.filename || 'image.jpg', caption, messageId);
    } else {
      await sendVideo(chatId, result.stream, result.filename || 'video.mp4', caption, messageId);
    }

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
