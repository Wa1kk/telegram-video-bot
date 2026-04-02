'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

/**
 * Lazy-import ESM modules (bgutils-js, youtubei.js are ESM-only).
 */
let _BG, _Innertube, _ytjs;

async function loadBG() {
  if (!_BG) _BG = (await import('bgutils-js')).BG;
  return _BG;
}

async function loadYtjs() {
  if (!_ytjs) {
    _ytjs = await import('youtubei.js');
    _Innertube = _ytjs.default || _ytjs.Innertube;

    // youtubei.js v17+ requires a custom JS evaluator for URL deciphering in Node.js.
    const { Platform } = _ytjs;
    if (Platform && Platform.shim) {
      Platform.shim.eval = async (data, env) => {
        const properties = [];
        if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
        if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
        const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
        return new Function(code)();
      };
    }
  }
  return { Innertube: _Innertube, ytjs: _ytjs };
}

// ---------------------------------------------------------------------------
// BotGuard environment (linkedom — lightweight, CommonJS-safe)
// ---------------------------------------------------------------------------

/**
 * Temporarily install DOM globals on globalThis so that BotGuard's script
 * can run.  Returns { cleanup }.
 */
function installBotGuardEnvironment() {
  const { parseHTML } = require('linkedom');
  const { window, document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');

  // Stubs that BotGuard may probe
  if (!window.location) window.location = { href: 'https://www.youtube.com', origin: 'https://www.youtube.com' };
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {} });
  if (!window.requestAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  if (!window.cancelAnimationFrame) window.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!window.getComputedStyle) window.getComputedStyle = () => ({});
  if (!window.navigator) window.navigator = { userAgent: 'Mozilla/5.0', language: 'en-US' };
  if (!window.crypto) window.crypto = require('crypto').webcrypto || require('crypto');
  if (!window.btoa) window.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  if (!window.atob) window.atob = (s) => Buffer.from(s, 'base64').toString('binary');

  const propsToSet = { window, document };
  const saved = {};
  for (const [key, val] of Object.entries(propsToSet)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: val, writable: true, configurable: true });
  }

  return {
    cleanup: () => {
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PoToken generation via BotGuard (bgutils-js + jsdom)
// ---------------------------------------------------------------------------

/**
 * Run the full BotGuard attestation flow and return a WebPoMinter + visitorData.
 *
 * Flow: fetch challenge -> execute BG interpreter in jsdom -> snapshot ->
 *       get integrity token -> create minter.
 *
 * Returns { minter, visitorData, sessionPoToken, cleanup }.
 */
async function createPoTokenSession() {
  const BG = await loadBG();
  const { Innertube } = await loadYtjs();

  const { cleanup } = installBotGuardEnvironment();

  try {
    // Get visitorData from YouTube (remote, not locally generated -- more trustworthy)
    const innertube = await Innertube.create({ enable_session_cache: false });
    const visitorData = innertube.session.context.client.visitorData;
    if (!visitorData) throw new Error('Could not obtain visitorData');

    const fetchFn = globalThis.fetch;
    const bgConfig = {
      fetch: fetchFn,
      globalObj: globalThis,
      identifier: visitorData,
      requestKey: REQUEST_KEY,
    };

    // 1. Fetch BotGuard challenge
    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error('Could not get BotGuard challenge');

    // 2. Execute the BotGuard interpreter script
    const interpreterJs = challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (interpreterJs) {
      new Function(interpreterJs)();
    } else {
      const scriptUrl = challenge.interpreterJavascript.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
      if (!scriptUrl) throw new Error('No BotGuard interpreter');
      const resp = await fetchFn(scriptUrl.startsWith('//') ? `https:${scriptUrl}` : scriptUrl);
      new Function(await resp.text())();
    }

    // 3. BotGuard snapshot
    const botguard = await BG.BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObj: globalThis,
    });
    const webPoSignalOutput = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

    // 4. Integrity token
    const itResp = await fetchFn(
      'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json+protobuf',
          'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
          'x-user-agent': 'grpc-web-javascript/0.1',
        },
        body: JSON.stringify([REQUEST_KEY, botguardResponse]),
      }
    );
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await itResp.json();

    // 5. WebPO minter
    const minter = await BG.WebPoMinter.create(
      { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
      webPoSignalOutput
    );

    const sessionPoToken = await minter.mintAsWebsafeString(visitorData);

    return { minter, visitorData, sessionPoToken, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function tmpFilePath() {
  const id = crypto.randomBytes(6).toString('hex');
  const tmpDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return path.join(tmpDir, `video_${id}.mp4`);
}

// ---------------------------------------------------------------------------
// Innertube download logic
// ---------------------------------------------------------------------------

async function doInnertubeDownload(innertube, videoId) {
  const info = await innertube.getBasicInfo(videoId);

  const title = info.basic_info?.title || '';
  const description = (info.basic_info?.short_description || '').substring(0, 500);

  // Check playability
  const status = info.playability_status?.status;
  if (status && status !== 'OK') {
    const reason = info.playability_status?.reason || status;
    throw new Error(reason);
  }

  const streamingData = info.streaming_data;
  if (!streamingData) {
    throw new Error('No streaming data available');
  }

  // Prefer progressive MP4 (video+audio combined)
  const formats = streamingData.formats || [];
  let format = formats
    .filter(f => f.mime_type?.startsWith('video/mp4'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!format) {
    format = formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }
  if (!format) {
    throw new Error('No suitable video format found');
  }

  // Get download URL (decipher is async in v17+)
  let downloadUrl;
  try {
    if (format.decipher) {
      const result = format.decipher(innertube.session.player);
      downloadUrl = (result && typeof result.then === 'function') ? await result : result;
    }
  } catch (e) {
    console.warn(`[YT] Decipher failed: ${e.message}`);
  }
  if (!downloadUrl) downloadUrl = format.url;
  if (!downloadUrl) throw new Error('Could not get download URL');
  if (typeof downloadUrl !== 'string') downloadUrl = String(downloadUrl);

  // Download to temp file
  const outFile = tmpFilePath();
  const response = await fetch(downloadUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`Video download HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outFile, buffer);

  const stat = fs.statSync(outFile);
  if (stat.size === 0) {
    fs.unlinkSync(outFile);
    throw new Error('Downloaded file is empty');
  }
  console.log(`[YT] Video: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));

  return { stream, title, description };
}

// ---------------------------------------------------------------------------
// Download strategies
// ---------------------------------------------------------------------------

/** Strategy 1: Full BotGuard PoToken (strongest auth). */
async function downloadWithPoToken(videoId) {
  const { minter, visitorData, sessionPoToken, cleanup } = await createPoTokenSession();
  try {
    const contentPoToken = await minter.mintAsWebsafeString(videoId);
    console.log(`[YT] PoToken for ${videoId}: ${contentPoToken.length} chars`);

    const { Innertube } = await loadYtjs();
    const innertube = await Innertube.create({
      po_token: sessionPoToken,
      visitor_data: visitorData,
      enable_session_cache: false,
    });
    return await doInnertubeDownload(innertube, videoId);
  } finally {
    cleanup();
  }
}

/** Strategy 2: Cold-start token (XOR placeholder, no BotGuard). */
async function downloadWithColdStartToken(videoId) {
  const BG = await loadBG();
  const { Innertube } = await loadYtjs();

  const yt = await Innertube.create({ enable_session_cache: false });
  const visitorData = yt.session.context.client.visitorData;
  if (!visitorData) throw new Error('No visitorData');

  const coldToken = BG.PoToken.generateColdStartToken(visitorData);
  console.log(`[YT] Cold-start token: ${coldToken.length} chars`);

  const innertube = await Innertube.create({
    po_token: coldToken,
    visitor_data: visitorData,
    enable_session_cache: false,
  });
  return await doInnertubeDownload(innertube, videoId);
}

/** Strategy 3: No token at all (works from some IPs). */
async function downloadWithoutToken(videoId) {
  const { Innertube } = await loadYtjs();
  const innertube = await Innertube.create({
    enable_session_cache: false,
  });
  return await doInnertubeDownload(innertube, videoId);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Download a YouTube or YouTube Shorts video.
 * Returns { stream, title, description }.
 *
 * Tries three strategies in order:
 *   1. BotGuard PoToken (bgutils-js + jsdom -- strongest auth)
 *   2. Cold-start token (lightweight placeholder)
 *   3. No token (works from clean residential IPs)
 *
 * If all strategies fail with LOGIN_REQUIRED, the server IP is likely
 * flagged by YouTube and a residential proxy is needed.
 */
async function getYouTubeVideo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  const strategies = [
    { name: 'BotGuard PoToken', fn: () => downloadWithPoToken(videoId) },
    { name: 'Cold-start token', fn: () => downloadWithColdStartToken(videoId) },
    { name: 'No token',         fn: () => downloadWithoutToken(videoId) },
  ];

  const errors = [];

  for (const { name, fn } of strategies) {
    try {
      console.log(`[YT] Trying: ${name}...`);
      return await fn();
    } catch (err) {
      console.warn(`[YT] ${name} failed: ${err.message}`);
      errors.push(`${name}: ${err.message}`);
    }
  }

  throw new Error(
    `All YouTube download strategies failed for ${videoId}:\n${errors.join('\n')}`
  );
}

module.exports = { getYouTubeVideo };
