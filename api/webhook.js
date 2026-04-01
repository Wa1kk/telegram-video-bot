'use strict';

const { processUpdate } = require('../lib/handler');

/**
 * Vercel Serverless Function — Telegram Webhook endpoint.
 * POST /api/webhook  →  called by Telegram on every update
 * GET  /api/webhook  →  health check
 */
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).send('Telegram Video Bot is running!');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Optional: validate the webhook secret to prevent unauthorized calls
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (header !== secret) {
      return res.status(403).send('Forbidden');
    }
  }

  // Respond immediately — Telegram requires a 200 within ~10 seconds.
  // The serverless function continues executing until processUpdate resolves
  // (Vercel keeps the function alive until the response is sent).
  // We send 200 AFTER processing so Vercel doesn't kill the execution early.
  try {
    await processUpdate(req.body);
  } catch (err) {
    // Never let an unhandled error prevent the 200 response
    console.error('Unhandled error in processUpdate:', err);
  }

  return res.status(200).json({ ok: true });
};
