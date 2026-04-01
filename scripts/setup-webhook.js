#!/usr/bin/env node
'use strict';

/**
 * Sets the Telegram webhook to point to your Vercel deployment.
 *
 * Usage:
 *   BOT_TOKEN=<token> node scripts/setup-webhook.js https://your-app.vercel.app
 *
 * Optional — with a secret token for request validation:
 *   BOT_TOKEN=<token> WEBHOOK_SECRET=<secret> node scripts/setup-webhook.js https://your-app.vercel.app
 */

const fetch = require('node-fetch');

async function main() {
  const token = process.env.BOT_TOKEN;
  const domain = process.argv[2];

  if (!token) {
    console.error('Error: BOT_TOKEN environment variable is required.');
    console.error('Usage: BOT_TOKEN=<token> node scripts/setup-webhook.js https://your-app.vercel.app');
    process.exit(1);
  }

  if (!domain) {
    console.error('Error: Vercel domain argument is required.');
    console.error('Usage: BOT_TOKEN=<token> node scripts/setup-webhook.js https://your-app.vercel.app');
    process.exit(1);
  }

  const webhookUrl = `${domain.replace(/\/$/, '')}/api/webhook`;

  const params = {
    url: webhookUrl,
    allowed_updates: ['message', 'channel_post'],
    drop_pending_updates: true,
  };

  // Add secret token if provided
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    params.secret_token = secret;
    console.log('Using webhook secret token for request validation.');
  }

  console.log(`Setting webhook to: ${webhookUrl}`);

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await response.json();

  if (data.ok) {
    console.log('Webhook set successfully!');
    console.log('Response:', JSON.stringify(data, null, 2));
  } else {
    console.error('Failed to set webhook:', data);
    process.exit(1);
  }

  // Show current webhook info
  const infoResponse = await fetch(
    `https://api.telegram.org/bot${token}/getWebhookInfo`
  );
  const info = await infoResponse.json();
  console.log('\nCurrent webhook info:');
  console.log(JSON.stringify(info.result, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
