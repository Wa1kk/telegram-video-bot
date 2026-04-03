'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const COBALT_INSTANCES = [
  'https://cobaltapi.cjs.nz',
  'https://api.cobalt.blackcat.sweeux.org',
  'https://cobaltapi.squair.xyz',
  'https://api.qwkuns.me',
  'https://fox.kittycat.boo',
  'https://api.dl.woof.monster',
];

const embedHeaders = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Dnt': '1',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': UA,
};

// ── URL parsing ──

function extractShortcode(url) {
  const share = url.match(/instagram\.com\/share\/(?:r|reel)\/([A-Za-z0-9_-]+)/);
  if (share) return share[1];
  const direct = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return direct ? direct[1] : null;
}

// ── Helper: extract JSON object from Instagram page entries ──
// Entries look like: ["Name",[],{...},123]

function getObjectFromEntries(name, html) {
  const re = new RegExp('\\["' + name + '",\\[\\],({.*?}),\\d+\\]');
  const match = html.match(re);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function getNumberFromQuery(name, html) {
  const m = html.match(new RegExp(name + '=(\\d+)'));
  return m ? +m[1] : null;
}

// ── Method 1: GQL with extracted tokens (primary) ──

async function fetchViaGQL(shortcode, useAuthCookie = false) {
  const igCookie = useAuthCookie ? process.env.IG_COOKIE : null;
  console.log(`[IG] Trying GQL method${igCookie ? ' (with auth cookie)' : ''}...`);

  // Step 1: Load the post page to extract tokens
  const pageHeaders = { ...embedHeaders };
  if (igCookie) pageHeaders['Cookie'] = igCookie;

  const pageRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
    headers: pageHeaders,
    timeout: 15000,
  });
  if (!pageRes.ok) throw new Error(`Page HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  const lsd = getObjectFromEntries('LSD', html)?.token
    || crypto.randomBytes(8).toString('base64url');
  const csrf = getObjectFromEntries('InstagramSecurityConfig', html)?.csrf_token;
  const polarisSiteData = getObjectFromEntries('PolarisSiteData', html);
  const siteData = getObjectFromEntries('SiteData', html);
  const webConfig = getObjectFromEntries('DGWWebConfig', html);
  const pushInfo = getObjectFromEntries('InstagramWebPushInfo', html);

  if (!csrf) throw new Error('No CSRF token found');

  // Use auth cookie if available, otherwise build anonymous cookie
  const requestCookie = igCookie || [
    'csrftoken=' + csrf,
    polarisSiteData?.device_id && 'ig_did=' + polarisSiteData.device_id,
    'wd=1280x720',
    'dpr=2',
    polarisSiteData?.machine_id && 'mid=' + polarisSiteData.machine_id,
    'ig_nrcb=1',
  ].filter(Boolean).join('; ');

  // Step 2: Make the GraphQL request
  const body = new URLSearchParams({
    __d: 'www',
    __a: '1',
    __s: '::' + Math.random().toString(36).substring(2).replace(/\d/g, '').slice(0, 6),
    __hs: siteData?.haste_session || '20126.HYP:instagram_web_pkg.2.1...0',
    __req: 'b',
    __ccg: 'EXCELLENT',
    __rev: pushInfo?.rollout_hash || '1019933358',
    __hsi: siteData?.hsi || '7436540909012459023',
    __dyn: crypto.randomBytes(154).toString('base64url'),
    __csr: crypto.randomBytes(154).toString('base64url'),
    __user: '0',
    __comet_req: String(getNumberFromQuery('__comet_req', html) || 7),
    av: '0',
    dpr: '2',
    lsd,
    jazoest: String(getNumberFromQuery('jazoest', html) || Math.floor(Math.random() * 10000)),
    __spin_r: siteData?.__spin_r || '1019933358',
    __spin_b: siteData?.__spin_b || 'trunk',
    __spin_t: String(siteData?.__spin_t || Math.floor(Date.now() / 1000)),
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    server_timestamps: 'true',
    doc_id: '8845758582119845',
  }).toString();

  const gqlRes = await fetch('https://www.instagram.com/graphql/query', {
    method: 'POST',
    headers: {
      ...embedHeaders,
      'x-ig-app-id': webConfig?.appId || '936619743392459',
      'X-FB-LSD': lsd,
      'X-CSRFToken': csrf,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
      'Cookie': requestCookie,
    },
    body,
    timeout: 15000,
  });

  const gqlData = await gqlRes.json();
  const media = gqlData?.data?.xdt_shortcode_media || gqlData?.data?.shortcode_media;
  if (!media) throw new Error('GQL returned null (content may be restricted)');

  return extractGqlMedia(media);
}

// ── Method 2: Instagram embed page ──

async function fetchViaEmbed(shortcode) {
  console.log('[IG] Trying embed method...');
  const res = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: embedHeaders,
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const html = await res.text();

  const initMatch = html.match(/"init",\[\],\[(.*?)\]\],/);
  if (!initMatch) throw new Error('No embed init data');

  let embedData = JSON.parse(initMatch[1]);
  if (!embedData?.contextJSON) throw new Error('No contextJSON');
  embedData = JSON.parse(embedData.contextJSON);

  const media = embedData?.gql_data?.shortcode_media || embedData?.gql_data?.xdt_shortcode_media;
  if (!media) throw new Error('No media in embed');

  return extractGqlMedia(media);
}

// ── Method 3: Cobalt API (last resort) ──

async function fetchViaCobalt(url) {
  console.log('[IG] Trying Cobalt...');
  const errors = [];
  for (const instance of COBALT_INSTANCES) {
    try {
      const res = await fetch(instance, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        timeout: 15000,
      });

      const data = await res.json();
      if (data.status === 'error') {
        errors.push(`${instance}: ${data.error?.code || 'unknown'}`);
        continue;
      }

      if (data.url) {
        const isVideo = !data.url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
        return [{ url: data.url, isVideo }];
      }

      if (data.picker && data.picker.length > 0) {
        return data.picker.map(p => ({ url: p.url, isVideo: p.type === 'video' }));
      }

      errors.push(`${instance}: unexpected response`);
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
    }
  }
  console.error(`[IG] All Cobalt failed:\n${errors.join('\n')}`);
  return null;
}

// ── Check if content is restricted ──

async function checkRestriction(shortcode) {
  try {
    const url = `https://i.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/${shortcode}/`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      timeout: 8000,
    });
    const data = await res.json();
    if (data.message === 'geoblock_required' || data.gating_type) {
      if (data.title?.includes('inappropriate')) return 'age';
      return 'restricted';
    }
  } catch {}
  return null;
}

// ── Extract media from GQL shortcode_media ──

function extractGqlMedia(media) {
  const items = [];

  // Carousel
  const sidecar = media.edge_sidecar_to_children;
  if (sidecar) {
    for (const edge of sidecar.edges) {
      const node = edge.node;
      if (!node) continue;
      if (node.is_video && node.video_url) {
        items.push({ url: node.video_url, isVideo: true });
      } else if (node.display_url) {
        items.push({ url: node.display_url, isVideo: false });
      }
    }
    if (items.length > 0) return items;
  }

  // Single video
  if (media.video_url) {
    return [{ url: media.video_url, isVideo: true }];
  }

  // Single photo
  if (media.display_url) {
    return [{ url: media.display_url, isVideo: false }];
  }

  throw new Error('No media URLs in response');
}

// ── Metadata scraping (for caption) ──

async function scrapeMetadata(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      redirect: 'follow',
      timeout: 10000,
    });
    if (!res.ok) return null;
    const html = await res.text();

    let username = '', fullName = '', description = '';

    const ownerMatch = html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
    if (ownerMatch) username = ownerMatch[1];

    const nameMatch = html.match(/"full_name"\s*:\s*"([^"]+)"/);
    if (nameMatch) fullName = nameMatch[1];

    const captionMatch = html.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (captionMatch) {
      try { description = JSON.parse(`"${captionMatch[1]}"`); } catch { description = captionMatch[1]; }
    }

    if (!username) {
      const ogAuthor = html.match(/content="@([^"]+)" .*?property="og:description"/);
      if (ogAuthor) username = ogAuthor[1];
    }

    if (username || fullName) {
      return { username, fullName: fullName || username, description };
    }
  } catch {}
  return null;
}

// ── Formatting ──

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCaption(meta) {
  if (!meta) return '';
  const profileUrl = `https://www.instagram.com/${meta.username}/`;
  const name = esc(meta.fullName || meta.username);
  const lines = [`👤 <a href="${profileUrl}">${name}</a>`];

  if (meta.description) {
    let desc = esc(meta.description);
    if (desc.length > 800) desc = desc.substring(0, 800) + '...';
    lines.push('', `<blockquote>${desc}</blockquote>`);
  }

  let text = lines.join('\n');
  if (text.length > 1024) text = text.substring(0, 1021) + '...';
  return text;
}

// ── Download ──

async function downloadToTmp(fileUrl, ext = 'mp4') {
  const id = crypto.randomBytes(6).toString('hex');
  const tmpDir = process.platform === 'win32' ? process.env.TEMP || 'C:\\Temp' : '/tmp';
  const outFile = `${tmpDir}/ig_${id}.${ext}`;

  const response = await fetch(fileUrl, {
    headers: { 'User-Agent': UA },
    timeout: 120000,
  });

  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }

  const fileStream = fs.createWriteStream(outFile);
  await new Promise((resolve, reject) => {
    fileStream.on('error', reject);
    response.body.on('error', reject);
    response.body.pipe(fileStream);
    fileStream.on('finish', resolve);
  });

  const stat = fs.statSync(outFile);
  if (stat.size === 0) {
    fs.unlinkSync(outFile);
    throw new Error('Downloaded file is empty');
  }
  console.log(`[IG] Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)} MB (${ext})`);

  const stream = fs.createReadStream(outFile);
  stream.on('close', () => fs.unlink(outFile, () => {}));
  return stream;
}

// ── Main entry point ──

async function getInstagramVideo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Невалидная ссылка Instagram');

  let items = null;

  // Method 1: GQL with extracted tokens (anonymous)
  try {
    items = await fetchViaGQL(shortcode, false);
    console.log('[IG] GQL succeeded');
  } catch (err) {
    console.warn(`[IG] GQL failed: ${err.message}`);
  }

  // Method 1b: GQL with auth cookie (for age-restricted content)
  if (!items && process.env.IG_COOKIE) {
    try {
      items = await fetchViaGQL(shortcode, true);
      console.log('[IG] GQL with auth cookie succeeded');
    } catch (err) {
      console.warn(`[IG] GQL auth failed: ${err.message}`);
    }
  }

  // Method 2: Embed page
  if (!items) {
    try {
      items = await fetchViaEmbed(shortcode);
      console.log('[IG] Embed succeeded');
    } catch (err) {
      console.warn(`[IG] Embed failed: ${err.message}`);
    }
  }

  // Method 3: Cobalt
  if (!items) {
    items = await fetchViaCobalt(url);
    if (items) console.log('[IG] Cobalt succeeded');
  }

  // If nothing worked, check why
  if (!items || items.length === 0) {
    const restriction = await checkRestriction(shortcode);
    if (restriction === 'age') {
      if (!process.env.IG_COOKIE) {
        throw new Error('Этот пост имеет возрастные ограничения. Добавьте IG_COOKIE в настройках для доступа.');
      }
      throw new Error('Этот пост имеет возрастные ограничения и недоступен.');
    }
    if (restriction === 'restricted') {
      throw new Error('Этот пост ограничен Instagram.');
    }
    throw new Error('Не удалось скачать из Instagram. Попробуйте позже.');
  }

  // Get caption metadata (non-blocking)
  const meta = await scrapeMetadata(url).catch(() => null);
  const caption = buildCaption(meta);

  // Single item
  if (items.length === 1) {
    const item = items[0];
    const ext = item.isVideo ? 'mp4' : 'jpg';
    const stream = await downloadToTmp(item.url, ext);
    return {
      stream,
      caption,
      type: item.isVideo ? 'video' : 'photo',
      filename: item.isVideo ? 'video.mp4' : 'image.jpg',
    };
  }

  // Carousel
  const downloaded = [];
  for (const item of items) {
    const ext = item.isVideo ? 'mp4' : 'jpg';
    const stream = await downloadToTmp(item.url, ext);
    downloaded.push({
      stream,
      type: item.isVideo ? 'video' : 'photo',
      filename: item.isVideo ? 'video.mp4' : 'image.jpg',
    });
  }

  return { items: downloaded, caption };
}

module.exports = { getInstagramVideo };
