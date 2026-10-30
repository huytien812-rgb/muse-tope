// TopE webapp — frontend logic. Runs on GitHub Pages (static).
// The client_secret NEVER lives here. All calls that need it go through
// the Cloudflare Worker backend (worker.js), whose URL goes in API_BASE.

// ---- CONFIG: fill these two values after the Worker is deployed ----
const CONFIG = {
  CLIENT_KEY: 'PASTE_CLIENT_KEY_HERE',   // public key from TikTok app Credentials
  API_BASE: 'https://PASTE_WORKER_URL_HERE', // e.g. https://tope-xxx.workers.dev (no trailing slash)
  SCOPES: 'user.info.basic,video.upload,video.publish',
};
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
const TOKENS_KEY = 'tope_tokens';

function redirectUri() {
  const dir = window.location.pathname.replace(/\/[^\/]*$/, '/');
  return window.location.origin + dir + 'callback.html';
}
function log(msg) {
  const el = document.getElementById('log');
  el.textContent += '\n' + msg;
  el.scrollTop = el.scrollHeight;
}
function getTokens() {
  try { return JSON.parse(localStorage.getItem(TOKENS_KEY) || 'null'); } catch { return null; }
}
function setTokens(t) {
  t.saved_at = Date.now();
  localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
}
function clearTokens() { localStorage.removeItem(TOKENS_KEY); }
function isExpired(t) {
  return !t || (Date.now() > t.saved_at + (t.expires_in - 60) * 1000);
}
async function api(path, body, token) {
  const res = await fetch(CONFIG.API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && (data.error?.message || data.error)) || ('HTTP ' + res.status));
  return data;
}
async function ensureToken() {
  let t = getTokens();
  if (!t) throw new Error('Not logged in. Log in with TikTok first.');
  if (isExpired(t)) {
    log('Access token expired, refreshing...');
    const fresh = await api('/api/auth/refresh', { refresh_token: t.refresh_token });
    t = { ...t, ...fresh };
    setTokens(t);
  }
  return t.access_token;
}

async function showAccount() {
  const t = getTokens();
  const loginBox = document.getElementById('loginBox');
  const accountBox = document.getElementById('accountBox');
  if (!t) { loginBox.style.display = ''; accountBox.style.display = 'none'; return; }
  loginBox.style.display = 'none'; accountBox.style.display = '';
  try {
    const info = await api('/api/user/info', {}, t.access_token);
    document.getElementById('accountInfo').textContent =
      'Connected as @' + (info.display_name || info.open_id) + ' (open_id: ' + info.open_id + ')';
  } catch (e) {
    document.getElementById('accountInfo').textContent = 'Connected (open_id: ' + t.open_id + '). Profile lookup failed: ' + e.message;
  }
}

function login() {
  if (CONFIG.CLIENT_KEY.includes('PASTE_')) { alert('CLIENT_KEY is not configured yet.'); return; }
  if (CONFIG.API_BASE.includes('PASTE_')) { alert('API_BASE (Worker URL) is not configured yet.'); return; }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('tope_state', state);
  const url = 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
    client_key: CONFIG.CLIENT_KEY,
    scope: CONFIG.SCOPES,
    response_type: 'code',
    redirect_uri: redirectUri(),
    state,
  }).toString();
  window.location.href = url;
}

async function upload(mode) {
  const fileInput = document.getElementById('file');
  const file = fileInput.files[0];
  const title = document.getElementById('title').value.trim();
  if (!file) { alert('Choose a video file first.'); return; }
  if (!title) { alert('Title is required.'); return; }
  const logEl = document.getElementById('log');
  logEl.textContent = 'Starting ' + mode + ' upload: ' + file.name + ' (' + file.size + ' bytes)';
  try {
    const token = await ensureToken();
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const privacy = document.getElementById('privacy').value;
    const init = await api('/api/video/init', {
      mode,
      post_info: {
        title,
        privacy_level: privacy,
        disable_duet: document.getElementById('noDuet').checked,
        disable_comment: document.getElementById('noComment').checked,
        disable_stitch: document.getElementById('noStitch').checked,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: file.size,
        chunk_size: CHUNK_SIZE,
        total_chunk_count: totalChunks,
      },
    }, token);
    const publishId = init.publish_id;
    const uploadUrl = init.upload_url;
    log('Init OK. publish_id=' + publishId + '. Uploading ' + totalChunks + ' chunk(s)...');
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunk = file.slice(start, end);
      const buf = await chunk.arrayBuffer();
      const res = await fetch(CONFIG.API_BASE + '/api/video/chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Url': uploadUrl,
          'X-Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + file.size,
        },
        body: buf,
      });
      if (!res.ok) throw new Error('Chunk ' + (i + 1) + ' upload failed (HTTP ' + res.status + ')');
      log('Chunk ' + (i + 1) + '/' + totalChunks + ' uploaded.');
    }
    log('All chunks uploaded. Waiting for TikTok to process...');
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await api('/api/video/status', { publish_id: publishId }, token);
      const status = st.status || JSON.stringify(st);
      log('Status: ' + status);
      if (status === 'PUBLISH_COMPLETE') {
        log(mode === 'draft' ? 'Done: video is in your TikTok inbox as a draft.' : 'Done: video published to your profile.');
        return;
      }
      if (status === 'FAILED') throw new Error('TikTok failed to process the video.');
    }
    log('Still processing after 5 minutes. Check TikTok later (publish_id=' + publishId + ').');
  } catch (e) {
    log('ERROR: ' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const warn = document.getElementById('configWarn');
  const missing = [];
  if (CONFIG.CLIENT_KEY.includes('PASTE_')) missing.push('CLIENT_KEY');
  if (CONFIG.API_BASE.includes('PASTE_')) missing.push('Worker URL (API_BASE)');
  if (missing.length) {
    warn.style.display = '';
    warn.textContent = 'Not configured yet: ' + missing.join(', ') + '. Login and upload are disabled until these are filled in app.js.';
    document.getElementById('loginBtn').disabled = true;
    document.getElementById('draftBtn').disabled = true;
    document.getElementById('publishBtn').disabled = true;
  }
  document.getElementById('loginBtn').addEventListener('click', login);
  document.getElementById('logoutBtn').addEventListener('click', () => { clearTokens(); location.reload(); });
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    try {
      const t = getTokens();
      const fresh = await api('/api/auth/refresh', { refresh_token: t.refresh_token });
      setTokens({ ...t, ...fresh });
      log('Token refreshed.');
      showAccount();
    } catch (e) { log('Refresh failed: ' + e.message); }
  });
  document.getElementById('draftBtn').addEventListener('click', () => upload('draft'));
  document.getElementById('publishBtn').addEventListener('click', () => upload('direct'));
  const params = new URLSearchParams(location.search);
  if (params.get('login') === 'ok') log('Login successful.');
  if (params.get('login') === 'error') log('Login failed: ' + (params.get('msg') || 'unknown error'));
  showAccount();
});
