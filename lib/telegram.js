'use strict';

const fetch = require('node-fetch');
const FormData = require('form-data');

function getBaseUrl() {
  return `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
}

async function callAPI(method, params) {
  const response = await fetch(`${getBaseUrl()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API [${method}]: ${data.description}`);
  }
  return data.result;
}

async function sendMessage(chatId, text, replyToMessageId) {
  return callAPI('sendMessage', {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
  });
}

async function editMessage(chatId, messageId, text) {
  return callAPI('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
  });
}

async function deleteMessage(chatId, messageId) {
  return callAPI('deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * Upload a video stream directly to Telegram.
 * @param {number} chatId
 * @param {import('stream').Readable} stream
 * @param {string} filename
 * @param {string} caption
 * @param {number} [replyToMessageId]
 */
async function sendVideo(chatId, stream, filename, caption, replyToMessageId) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', stream, {
    filename: filename || 'video.mp4',
    contentType: 'video/mp4',
  });
  if (caption) {
    form.append('caption', caption.substring(0, 1024));
  }
  if (replyToMessageId) {
    form.append('reply_to_message_id', String(replyToMessageId));
  }
  // Supports_streaming makes Telegram show progress bar while uploading
  form.append('supports_streaming', 'true');

  const response = await fetch(`${getBaseUrl()}/sendVideo`, {
    method: 'POST',
    body: form,
    // Allow up to 5 min for large video uploads
    timeout: 290000,
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram sendVideo: ${data.description}`);
  }
  return data.result;
}

module.exports = { callAPI, sendMessage, editMessage, deleteMessage, sendVideo };
