// TopE backend — Cloudflare Worker (free tier).
// Deploy: create a Worker at workers.cloudflare.com, paste this file,
// then set two secrets in the Worker dashboard (Settings → Variables):
//   CLIENT_KEY    = your TikTok app client_key
//   CLIENT_SECRET = your TikTok app client_secret (never put it in this file)
// The frontend origin allowed below must match your Pages site.

const ALLOWED_ORIGIN = 'https://huytien812-rgb.github.io';
const TIKTOK_API = 'https://open.tiktokapis.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Url, X-Content-Range',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
async function tiktok(path, token, body) {
  const res = await fetch(TIKTOK_API + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.code || ('TikTok HTTP ' + res.status);
    throw new Error(msg);
  }
  return data.data || data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    try {
      // ---- Auth: exchange authorization code for tokens ----
      if (url.pathname === '/api/auth/callback' && request.method === 'POST') {
        const { code, redirect_uri } = await request.json();
        const form = new URLSearchParams({
          client_key: env.CLIENT_KEY,
          client_secret: env.CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri,
        });
        const res = await fetch(TIKTOK_API + '/v2/oauth/token/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || data?.error?.code || ('Token exchange failed (HTTP ' + res.status + ')'));
        return json(data);
      }
      // ---- Auth: refresh access token ----
      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        const { refresh_token } = await request.json();
        const form = new URLSearchParams({
          client_key: env.CLIENT_KEY,
          client_secret: env.CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token,
        });
        const res = await fetch(TIKTOK_API + '/v2/oauth/token/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || data?.error?.code || ('Token refresh failed (HTTP ' + res.status + ')'));
        return json(data);
      }
      // ---- User info ----
      if (url.pathname === '/api/user/info' && request.method === 'POST') {
        const { access_token } = await request.json();
        const res = await fetch(TIKTOK_API + '/v2/user/info/?fields=open_id,display_name,avatar_url', {
          headers: { 'Authorization': 'Bearer ' + access_token },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || 'User info failed');
        return json(data.data?.user || data.data || {});
      }
      // ---- Video init (direct post and draft share one init endpoint;
      // the token's scopes decide the outcome: video.publish = direct,
      // video.upload = inbox draft) ----
      if (url.pathname === '/api/video/init' && request.method === 'POST') {
        const { access_token, post_info, source_info } = await request.json();
        const data = await tiktok('/v2/post/publish/video/init/', access_token, { post_info, source_info });
        return json(data);
      }
      // ---- Video chunk upload (proxied so the browser never talks to
      // TikTok's upload host directly; upload_url already carries its token) ----
      if (url.pathname === '/api/video/chunk' && request.method === 'POST') {
        const uploadUrl = request.headers.get('X-Upload-Url');
        const range = request.headers.get('X-Content-Range');
        if (!uploadUrl || !range) throw new Error('Missing upload URL or content range');
        const body = await request.arrayBuffer();
        const res = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'video/mp4', 'Content-Range': range },
          body,
        });
        if (!res.ok) throw new Error('TikTok chunk upload failed (HTTP ' + res.status + ')');
        return json({ ok: true });
      }
      // ---- Publish status polling ----
      if (url.pathname === '/api/video/status' && request.method === 'POST') {
        const { access_token, publish_id } = await request.json();
        const data = await tiktok('/v2/post/publish/status/fetch/', access_token, { publish_id });
        return json(data);
      }
      return json({ error: 'Unknown route' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};
