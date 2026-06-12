// ============================================================
//  日历助手 — popup.js  v2.0
//  所有 API Key / OAuth 凭据均从 chrome.storage.local 动态读取
//  请勿在代码中明文填写任何密钥，直接在扩展设置面板中输入即可
// ============================================================

// ---- 运行时配置（由 loadCFG 从本地存储填充）----
let CFG = {
  GEMINI_KEY:    '',
  OPENAI_KEY:    '',
  DEEPSEEK_KEY:  '',
  CLIENT_ID:     '',
  CLIENT_SECRET: ''
};

let selectedModel    = '';         // 当前生效的模型 ID
let selectedProvider = 'gemini';   // 当前生效的服务商
let panelProvider    = 'gemini';   // 面板上正在查看的服务商
let isTestingAll     = false;      // 一键测试进行中标志

const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks';

// 1×1 白色 PNG，用于多模态连通性测试
const _TEST_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

const $ = id => document.getElementById(id);

let imgBase64 = null;
let imgMime   = null;
let activeZone = 'cal';

// ============================================================
//  初始化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadCFG();
  await initModelPanel();
  fillCredFields();

  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  $('redirect-uri-text').textContent = redirectUri;

  await refreshAuthUI();

  document.addEventListener('paste', onPaste);

  $('paste-zone-cal').addEventListener('click', () => { activeZone = 'cal';  $('paste-zone-cal').focus(); });
  $('paste-zone-task').addEventListener('click', () => { activeZone = 'task'; $('paste-zone-task').focus(); });

  // 日历板块
  $('reset-btn').addEventListener('click', resetCal);
  $('new-btn-cal').addEventListener('click', resetCal);
  $('create-btn').addEventListener('click', onCreateEvent);

  // 待办板块
  $('reset-task-btn').addEventListener('click', resetTask);
  $('new-btn-task').addEventListener('click', resetTask);
  $('create-task-btn').addEventListener('click', onCreateTask);

  // AI 模型面板
  $('model-panel-header').addEventListener('click', toggleModelPanel);
  $('provider-select').addEventListener('change', onProviderChange);
  $('btn-save-apikey').addEventListener('click', saveApiKey);
  $('btn-fetch-models').addEventListener('click', fetchModels);
  $('btn-test-all').addEventListener('click', testAllModels);

  // Google 凭据面板
  $('cred-panel-header').addEventListener('click', toggleCredPanel);
  $('btn-save-client-id').addEventListener('click', saveClientId);
  $('btn-save-client-secret').addEventListener('click', saveClientSecret);
});

// ============================================================
//  配置读取
// ============================================================
async function loadCFG() {
  const d = await chrome.storage.local.get([
    'gemini_api_key', 'openai_api_key', 'deepseek_api_key',
    'google_client_id', 'google_client_secret'
  ]);
  CFG.GEMINI_KEY    = d.gemini_api_key       || '';
  CFG.OPENAI_KEY    = d.openai_api_key       || '';
  CFG.DEEPSEEK_KEY  = d.deepseek_api_key     || '';
  CFG.CLIENT_ID     = d.google_client_id     || '';
  CFG.CLIENT_SECRET = d.google_client_secret || '';
}

function getApiKey(provider) {
  if (provider === 'gemini')   return CFG.GEMINI_KEY;
  if (provider === 'openai')   return CFG.OPENAI_KEY;
  if (provider === 'deepseek') return CFG.DEEPSEEK_KEY;
  return '';
}

// ============================================================
//  凭据保存
// ============================================================
async function saveApiKey() {
  const key = $('api-key-input').value.trim();
  const map  = { gemini: 'gemini_api_key', openai: 'openai_api_key', deepseek: 'deepseek_api_key' };
  await chrome.storage.local.set({ [map[panelProvider]]: key });
  if (panelProvider === 'gemini')   CFG.GEMINI_KEY   = key;
  if (panelProvider === 'openai')   CFG.OPENAI_KEY   = key;
  if (panelProvider === 'deepseek') CFG.DEEPSEEK_KEY = key;
  updateApiKeyInput();
  flashBtn($('btn-save-apikey'));
}

async function saveClientId() {
  const id = $('input-client-id').value.trim();
  CFG.CLIENT_ID = id;
  await chrome.storage.local.set({ google_client_id: id });
  flashBtn($('btn-save-client-id'));
}

async function saveClientSecret() {
  const secret = $('input-client-secret').value.trim();
  CFG.CLIENT_SECRET = secret;
  await chrome.storage.local.set({ google_client_secret: secret });
  flashBtn($('btn-save-client-secret'));
}

function flashBtn(btn) {
  const orig = btn.textContent;
  btn.textContent = '✅';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

function fillCredFields() {
  $('input-client-id').value     = CFG.CLIENT_ID     || '';
  $('input-client-secret').value = CFG.CLIENT_SECRET || '';
}

// ============================================================
//  登录状态 UI
// ============================================================
async function refreshAuthUI() {
  const token = await getValidToken();
  const area  = $('auth-area');
  if (token) {
    area.innerHTML = `<div class="logged-in-badge"><div class="dot"></div>已登录</div>`;
  } else {
    area.innerHTML = `<button class="login-btn" id="login-btn">登录谷歌账号</button>`;
    $('login-btn').addEventListener('click', onLogin);
  }
}

// ============================================================
//  OAuth 2.0 登录（PKCE）
// ============================================================
function randomBase64url(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function sha256Base64url(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function onLogin() {
  if (!CFG.CLIENT_ID || !CFG.CLIENT_SECRET) {
    $('setup-notice').classList.remove('hidden');
    showError('请先在「🔑 Google 凭据」面板中填写 Client ID 和 Client Secret，然后保存，再点登录。');
    return;
  }

  const loginBtn = $('login-btn');
  if (loginBtn) { loginBtn.textContent = '登录中…'; loginBtn.disabled = true; }
  hideError();

  const verifier    = randomBase64url(32);
  const challenge   = await sha256Base64url(verifier);
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',             CFG.CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',          redirectUri);
  authUrl.searchParams.set('response_type',         'code');
  authUrl.searchParams.set('scope',                 SCOPES);
  authUrl.searchParams.set('code_challenge',        challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type',           'offline');
  authUrl.searchParams.set('prompt',                'consent');

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
    const code = new URL(responseUrl).searchParams.get('code');
    if (!code) throw new Error('未获取到授权码');

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     CFG.CLIENT_ID,
        client_secret: CFG.CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        code_verifier: verifier
      })
    });
    const tok = await resp.json();
    if (!tok.access_token) throw new Error(tok.error_description || tok.error || '获取 token 失败');

    await chrome.storage.local.set({
      access_token:  tok.access_token,
      refresh_token: tok.refresh_token || null,
      token_expiry:  Date.now() + tok.expires_in * 1000
    });
    $('setup-notice').classList.add('hidden');
    await refreshAuthUI();

  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('redirect_uri_mismatch') || msg.includes('400')) {
      $('setup-notice').classList.remove('hidden');
      showError('重定向地址未配置，请按上方说明操作后再登录。');
    } else if (msg.includes('canceled') || msg.includes('user_cancelled')) {
      showError('已取消登录。');
    } else {
      showError('登录失败：' + msg);
    }
    await refreshAuthUI();
  }
}

// ============================================================
//  Token 刷新
// ============================================================
async function getValidToken() {
  const d = await chrome.storage.local.get(['access_token', 'refresh_token', 'token_expiry']);
  if (!d.access_token) return null;
  if (d.token_expiry && Date.now() < d.token_expiry - 300_000) return d.access_token;

  if (d.refresh_token && CFG.CLIENT_ID && CFG.CLIENT_SECRET) {
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     CFG.CLIENT_ID,
          client_secret: CFG.CLIENT_SECRET,
          refresh_token: d.refresh_token,
          grant_type:    'refresh_token'
        })
      });
      const tok = await resp.json();
      if (tok.access_token) {
        await chrome.storage.local.set({ access_token: tok.access_token, token_expiry: Date.now() + tok.expires_in * 1000 });
        return tok.access_token;
      }
    } catch (e) { console.warn('Token refresh failed:', e); }
  }
  await chrome.storage.local.remove(['access_token', 'token_expiry']);
  return null;
}

// ============================================================
//  粘贴截图
// ============================================================
function onPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    imgMime = item.type;
    const zoneId = activeZone === 'task' ? 'paste-zone-task' : 'paste-zone-cal';
    const reader = new FileReader();
    reader.onload = ev => {
      imgBase64 = ev.target.result.split(',')[1];
      $(zoneId).innerHTML = `<img src="${ev.target.result}" alt="截图预览">`;
      if (activeZone === 'task') analyzeWithAITask(); else analyzeWithAI();
    };
    reader.readAsDataURL(file);
    break;
  }
}

// ============================================================
//  AI 图片分析（日历事件）
// ============================================================
async function analyzeWithAI() {
  showLoading('loading-cal', true);
  hideError();
  const today = new Date().toLocaleDateString('sv-SE');
  const prompt = `分析这张截图，提取其中的日历事件信息。今天是 ${today}。
请只返回一个 JSON 对象，不要有任何其他文字，格式如下：
{
  "title": "事件标题",
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM",
  "endTime": "HH:MM",
  "location": "地点，没有则为空字符串",
  "description": "备注，没有则为空字符串"
}
- date 如果截图没有明确日期，就用今天 ${today}
- endTime 如果截图没有，就比 startTime 多加 1 小时
- 时间用 24 小时制`;
  try {
    const event = await callAI(prompt);
    fillForm(event);
  } catch (err) {
    showError('识别失败：' + err.message + '\n你可以手动填写下方表单。');
    fillForm({});
  } finally {
    showLoading('loading-cal', false);
  }
}

// ============================================================
//  AI 图片分析（待办事项）
// ============================================================
async function analyzeWithAITask() {
  showLoading('loading-task', true);
  hideError();
  const today = new Date().toLocaleDateString('sv-SE');
  const prompt = `分析这张截图，提取其中的待办事项/任务信息。今天是 ${today}。
请只返回一个 JSON 对象，不要有任何其他文字，格式如下：
{
  "title": "待办标题",
  "dueDate": "YYYY-MM-DD，没有明确日期就留空字符串",
  "notes": "备注/详情，没有则为空字符串"
}
- 这是一个待办事项/任务清单，不需要具体的开始结束时间
- 如果截图里有明显的截止日期、deadline，填入 dueDate，否则留空字符串`;
  try {
    const task = await callAI(prompt);
    fillTaskForm(task);
  } catch (err) {
    showError('识别失败：' + err.message + '\n你可以手动填写下方表单。');
    fillTaskForm({});
  } finally {
    showLoading('loading-task', false);
  }
}

// ============================================================
//  callAI — 路由到当前服务商的 API
// ============================================================
async function callAI(prompt) {
  const apiKey = getApiKey(selectedProvider);
  if (!apiKey) throw new Error(`${selectedProvider.toUpperCase()} API Key 未配置，请在「⚙️ AI 模型」面板填写并保存。`);
  if (!selectedModel) throw new Error('未选择模型，请在「⚙️ AI 模型」面板获取列表并点击「选择」。');
  if (selectedProvider === 'gemini')   return callGeminiAPI(apiKey, prompt);
  if (selectedProvider === 'openai')   return callOpenAIAPI(apiKey, prompt);
  if (selectedProvider === 'deepseek') return callDeepSeekAPI(apiKey, prompt);
  throw new Error('未知服务商：' + selectedProvider);
}

async function callGeminiAPI(apiKey, prompt) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: imgMime, data: imgBase64 } },
          { text: prompt }
        ]}],
        generationConfig: { temperature: 0, response_mime_type: 'application/json' }
      })
    }
  );
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || `API 错误 ${resp.status}`); }
  const data = await resp.json();
  let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(raw);
}

async function callOpenAIAPI(apiKey, prompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${imgMime};base64,${imgBase64}` } },
        { type: 'text', text: prompt }
      ]}],
      temperature: 0,
      max_tokens: 1000
    })
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || `API 错误 ${resp.status}`); }
  const data = await resp.json();
  let raw = data.choices?.[0]?.message?.content || '';
  raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(raw);
}

async function callDeepSeekAPI(apiKey, prompt) {
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${imgMime};base64,${imgBase64}` } },
        { type: 'text', text: prompt }
      ]}],
      temperature: 0
    })
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || `API 错误 ${resp.status}`); }
  const data = await resp.json();
  let raw = data.choices?.[0]?.message?.content || '';
  raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(raw);
}

// ============================================================
//  填充表单（日历事件）
// ============================================================
function fillForm(ev) {
  $('paste-zone-cal').classList.add('hidden');
  $('loading-cal').classList.add('hidden');
  $('event-form').classList.remove('hidden');
  $('success-view-cal').classList.add('hidden');
  const today = new Date().toLocaleDateString('sv-SE');
  $('f-title').value    = ev.title       || '';
  $('f-date').value     = ev.date        || today;
  $('f-start').value    = ev.startTime   || '';
  $('f-end').value      = ev.endTime     || addHour(ev.startTime);
  $('f-location').value = ev.location    || '';
  $('f-desc').value     = ev.description || '';
}

function fillTaskForm(t) {
  $('paste-zone-task').classList.add('hidden');
  $('loading-task').classList.add('hidden');
  $('task-form').classList.remove('hidden');
  $('success-view-task').classList.add('hidden');
  $('t-title').value = t.title   || '';
  $('t-due').value   = t.dueDate || '';
  $('t-notes').value = t.notes   || '';
}

function addHour(t) {
  if (!t || !t.includes(':')) return '';
  let [h, m] = t.split(':').map(Number);
  h = (h + 1) % 24;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ============================================================
//  创建日历事件
// ============================================================
async function onCreateEvent() {
  hideError();
  const token = await getValidToken();
  if (!token) { showError('请先登录谷歌账号。'); await refreshAuthUI(); return; }

  const title = $('f-title').value.trim();
  const date  = $('f-date').value;
  const start = $('f-start').value;
  const end   = $('f-end').value || addHour(start);

  if (!title) { showError('请填写标题。'); return; }
  if (!date)  { showError('请填写日期。'); return; }
  if (!start) { showError('请填写开始时间。'); return; }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    summary:     title,
    location:    $('f-location').value || undefined,
    description: $('f-desc').value     || undefined,
    start: { dateTime: `${date}T${start}:00`, timeZone: tz },
    end:   { dateTime: `${date}T${end}:00`,   timeZone: tz }
  };

  const btn = $('create-btn');
  btn.disabled = true; btn.textContent = '创建中…';
  try {
    const resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await resp.json();
    if (!resp.ok) {
      if (resp.status === 401) { await chrome.storage.local.remove(['access_token', 'token_expiry']); await refreshAuthUI(); throw new Error('登录已过期，请重新登录。'); }
      throw new Error(result.error?.message || `创建失败 (${resp.status})`);
    }
    $('event-form').classList.add('hidden');
    $('success-view-cal').classList.remove('hidden');
    $('success-detail-cal').textContent = `${title}  ·  ${date}  ${start}–${end}`;
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = '✅ 创建到谷歌日历';
  }
}

// ============================================================
//  创建待办事项
// ============================================================
async function onCreateTask() {
  hideError();
  const token = await getValidToken();
  if (!token) { showError('请先登录谷歌账号。'); await refreshAuthUI(); return; }

  const title = $('t-title').value.trim();
  const due   = $('t-due').value;
  const notes = $('t-notes').value;
  if (!title) { showError('请填写标题。'); return; }

  const body = { title, notes: notes || undefined };
  if (due) body.due = `${due}T00:00:00.000Z`;

  const btn = $('create-task-btn');
  btn.disabled = true; btn.textContent = '添加中…';
  try {
    const resp = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await resp.json();
    if (!resp.ok) {
      if (resp.status === 401) { await chrome.storage.local.remove(['access_token', 'token_expiry']); await refreshAuthUI(); throw new Error('登录已过期，请重新登录。'); }
      if (resp.status === 403) throw new Error('没有待办事项权限，请重新登录授权。');
      throw new Error(result.error?.message || `添加失败 (${resp.status})`);
    }
    $('task-form').classList.add('hidden');
    $('success-view-task').classList.remove('hidden');
    $('success-detail-task').textContent = due ? `${title}  ·  截止 ${due}` : title;
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = '✅ 添加到待办清单';
  }
}

// ============================================================
//  重置
// ============================================================
function resetCal() {
  imgBase64 = null; imgMime = null;
  const zone = $('paste-zone-cal');
  zone.innerHTML = `<div class="big-icon">🖼️</div><div class="hint">点这里，然后按 Ctrl+V 粘贴截图</div><div class="sub">截图后直接粘贴即可，支持 PNG / JPG</div>`;
  zone.classList.remove('hidden');
  $('loading-cal').classList.add('hidden');
  $('event-form').classList.add('hidden');
  $('success-view-cal').classList.add('hidden');
  hideError(); activeZone = 'cal'; zone.focus();
}

function resetTask() {
  imgBase64 = null; imgMime = null;
  const zone = $('paste-zone-task');
  zone.innerHTML = `<div class="big-icon">📝</div><div class="hint">点这里，然后按 Ctrl+V 粘贴截图</div><div class="sub">截图后直接粘贴即可，支持 PNG / JPG</div>`;
  zone.classList.remove('hidden');
  $('loading-task').classList.add('hidden');
  $('task-form').classList.add('hidden');
  $('success-view-task').classList.add('hidden');
  hideError(); activeZone = 'task'; zone.focus();
}

// ============================================================
//  模型面板：初始化
// ============================================================
async function initModelPanel() {
  const d = await chrome.storage.local.get(['selected_model', 'selected_provider']);
  selectedModel    = d.selected_model    || '';
  selectedProvider = d.selected_provider || 'gemini';
  panelProvider    = selectedProvider;
  updateModelBadge();
  $('provider-select').value = panelProvider;
  updateApiKeyInput();
}

function updateModelBadge() {
  const badge = $('model-current-name');
  if (!badge) return;
  if (!selectedModel) { badge.textContent = '未配置'; return; }
  const names = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };
  badge.textContent = `${names[selectedProvider] || selectedProvider} · ${selectedModel}`;
}

function updateApiKeyInput() {
  const key = getApiKey(panelProvider);
  const input = $('api-key-input');
  input.value = key || '';
  // 已保存则显示提示
  $('apikey-saved-hint').textContent = key ? '已保存' : '';
}

// ============================================================
//  模型面板：Provider 切换
// ============================================================
function onProviderChange() {
  panelProvider = $('provider-select').value;
  updateApiKeyInput();
  // 清空模型列表
  $('model-list-area').innerHTML = '';
  $('model-list-area').classList.add('hidden');
  $('btn-test-all').classList.add('hidden');
  $('model-fetch-status').textContent = '';

  // 该服务商已保存过 API Key 的话，切换后自动获取模型列表
  if (getApiKey(panelProvider)) {
    fetchModels();
  }
}

// ============================================================
//  面板展开/收起
// ============================================================
function toggleModelPanel() {
  const body = $('model-panel-body'), toggle = $('model-toggle');
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  toggle.textContent = isOpen ? '▼' : '▲';
}

function toggleCredPanel() {
  const body = $('cred-panel-body'), toggle = $('cred-toggle');
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  toggle.textContent = isOpen ? '▼' : '▲';
}

// ============================================================
//  获取模型列表
// ============================================================
async function fetchModels() {
  const apiKey   = getApiKey(panelProvider);
  const statusEl = $('model-fetch-status');
  const btn      = $('btn-fetch-models');

  if (!apiKey) { statusEl.textContent = '⚠️ 请先输入并保存 API Key'; return; }

  btn.disabled = true; btn.textContent = '获取中…';
  statusEl.textContent = '';
  $('model-list-area').innerHTML = '';
  $('model-list-area').classList.add('hidden');
  $('btn-test-all').classList.add('hidden');

  try {
    let models = [];
    if (panelProvider === 'gemini')   models = await fetchGeminiModels(apiKey);
    if (panelProvider === 'openai')   models = await fetchOpenAIModels(apiKey);
    if (panelProvider === 'deepseek') models = await fetchDeepSeekModels(apiKey);

    if (models.length === 0) { statusEl.textContent = '未找到可用模型，请检查 API Key'; return; }
    renderModelList(models);
    statusEl.textContent = `找到 ${models.length} 个模型`;
    $('btn-test-all').classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = '❌ 获取失败：' + err.message;
  } finally {
    btn.disabled = false; btn.textContent = '🔍 获取模型列表';
  }
}

async function fetchGeminiModels(apiKey) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
  const data = await resp.json();
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name.replace('models/', '') }));
}

async function fetchOpenAIModels(apiKey) {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
  const data = await resp.json();
  return (data.data || [])
    .filter(m => {
      const id = m.id.toLowerCase();
      if (['embed', 'whisper', 'dall-e', 'tts', 'instruct', 'babbage', 'curie', 'davinci'].some(x => id.includes(x))) return false;
      return ['gpt-', 'o1', 'o3', 'o4', 'chatgpt'].some(x => id.startsWith(x));
    })
    .sort((a, b) => b.id.localeCompare(a.id))
    .map(m => ({ id: m.id, name: m.id }));
}

async function fetchDeepSeekModels(apiKey) {
  const resp = await fetch('https://api.deepseek.com/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
  const data = await resp.json();
  return (data.data || []).map(m => ({ id: m.id, name: m.id }));
}

// ============================================================
//  渲染模型列表
// ============================================================
function renderModelList(models) {
  const area     = $('model-list-area');
  const provider = panelProvider;
  area.innerHTML = '';
  area.classList.remove('hidden');

  models.forEach(model => {
    const item = document.createElement('div');
    item.className        = 'model-item';
    item.dataset.modelId  = model.id;
    item.dataset.provider = provider;
    if (model.id === selectedModel && provider === selectedProvider) item.classList.add('selected');

    item.innerHTML = `
      <div class="model-item-main">
        <span class="model-status-dot" title="未测试"></span>
        <span class="model-name" title="${model.name}">${model.name}</span>
        <div class="model-btns">
          <button class="btn-test-single" title="单独测试此模型">⚡</button>
          <button class="btn-select-model">选择</button>
        </div>
      </div>
      <div class="model-error-row hidden">
        <span class="model-error-text"></span>
        <button class="btn-copy-error" title="复制完整错误信息">复制</button>
      </div>
    `;

    item.querySelector('.btn-test-single').addEventListener('click', e => {
      e.stopPropagation();
      testSingleModel(item, model.id);
    });

    item.querySelector('.btn-select-model').addEventListener('click', e => {
      e.stopPropagation();
      selectModel(item, model.id, provider);
    });

    item.querySelector('.btn-copy-error').addEventListener('click', e => {
      e.stopPropagation();
      const fullErr = item.querySelector('.model-error-text').dataset.full || '';
      copyText(fullErr, e.currentTarget);
    });

    area.appendChild(item);
  });
}

// ============================================================
//  选择模型（保存）
// ============================================================
async function selectModel(itemEl, modelId, provider) {
  document.querySelectorAll('.model-item.selected').forEach(el => el.classList.remove('selected'));
  itemEl.classList.add('selected');
  selectedModel    = modelId;
  selectedProvider = provider;
  await chrome.storage.local.set({ selected_model: modelId, selected_provider: provider });
  updateModelBadge();
  const btn = itemEl.querySelector('.btn-select-model');
  const orig = btn.textContent;
  btn.textContent = '✅';
  setTimeout(() => { btn.textContent = orig; }, 1000);
}

// ============================================================
//  单独测试某个模型
// ============================================================
async function testSingleModel(itemEl, modelId) {
  const dot     = itemEl.querySelector('.model-status-dot');
  const errRow  = itemEl.querySelector('.model-error-row');
  const errTxt  = itemEl.querySelector('.model-error-text');
  const singleBtn = itemEl.querySelector('.btn-test-single');

  const apiKey = getApiKey(panelProvider);
  if (!apiKey) {
    setModelFail(dot, errTxt, errRow, 'API Key 未配置，请先输入并保存');
    return;
  }

  dot.className = 'model-status-dot testing';
  dot.title = '测试中…';
  errRow.classList.add('hidden');
  singleBtn.disabled = true;
  singleBtn.textContent = '…';

  try {
    const result = await runTest(panelProvider, apiKey, modelId);
    if (result.ok) {
      dot.className = 'model-status-dot pass';
      dot.title = '连通性测试通过 ✓';
    } else {
      setModelFail(dot, errTxt, errRow, result.error);
    }
  } catch (err) {
    setModelFail(dot, errTxt, errRow, err.message);
  } finally {
    singleBtn.disabled = false;
    singleBtn.textContent = '⚡';
  }
}

// ============================================================
//  一键顺序测试（可中途停止）
// ============================================================
async function testAllModels() {
  const btn = $('btn-test-all');

  // 如果正在测试，点击即停止
  if (isTestingAll) {
    isTestingAll = false;
    return;
  }

  const items = Array.from($('model-list-area').querySelectorAll('.model-item'));
  if (items.length === 0) return;

  const apiKey = getApiKey(panelProvider);
  if (!apiKey) { $('model-fetch-status').textContent = '⚠️ 请先输入并保存 API Key'; return; }

  // 重置所有状态
  items.forEach(item => {
    const dot = item.querySelector('.model-status-dot');
    dot.className = 'model-status-dot';
    dot.title = '等待测试';
    item.querySelector('.model-error-row').classList.add('hidden');
  });

  isTestingAll = true;
  btn.textContent = '⏹ 停止';
  btn.classList.add('stopping');

  const statusEl = $('model-fetch-status');
  let passed = 0, failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (!isTestingAll) break;

    const item    = items[i];
    const modelId = item.dataset.modelId;
    const dot     = item.querySelector('.model-status-dot');
    const errRow  = item.querySelector('.model-error-row');
    const errTxt  = item.querySelector('.model-error-text');
    const singleBtn = item.querySelector('.btn-test-single');

    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    dot.className = 'model-status-dot testing';
    dot.title = '测试中…';
    singleBtn.disabled = true;
    singleBtn.textContent = '…';
    statusEl.textContent = `测试中 ${i + 1}/${items.length}：${modelId}`;

    try {
      const result = await runTest(panelProvider, apiKey, modelId);
      if (result.ok) {
        dot.className = 'model-status-dot pass';
        dot.title = '连通性测试通过 ✓';
        passed++;
      } else {
        setModelFail(dot, errTxt, errRow, result.error);
        failed++;
      }
    } catch (err) {
      setModelFail(dot, errTxt, errRow, err.message);
      failed++;
    } finally {
      singleBtn.disabled = false;
      singleBtn.textContent = '⚡';
    }
  }

  isTestingAll = false;
  btn.textContent = '⚡ 一键测试';
  btn.classList.remove('stopping');

  const tested = passed + failed;
  if (tested > 0) {
    statusEl.textContent = `测试完成：✅ ${passed} 可用  ❌ ${failed} 不可用`;
  } else {
    statusEl.textContent = '已停止';
  }
}

// ============================================================
//  底层测试逻辑
// ============================================================
async function runTest(provider, apiKey, modelId) {
  if (provider === 'gemini')   return runGeminiTest(apiKey, modelId);
  if (provider === 'openai')   return runOpenAITest(apiKey, modelId);
  if (provider === 'deepseek') return runDeepSeekTest(apiKey, modelId);
  return { ok: false, error: '未知服务商' };
}

async function runGeminiTest(apiKey, modelId) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: 'image/png', data: _TEST_PNG } },
          { text: '连接测试，只回复 OK' }
        ]}],
        generationConfig: { temperature: 0, maxOutputTokens: 10 }
      })
    }
  );
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data.error?.message || JSON.stringify(data.error) || `HTTP ${resp.status}`;
    return { ok: false, error: `[${resp.status}] ${msg}` };
  }
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!reply) return { ok: false, error: '响应为空，此模型可能不支持多模态输入' };
  return { ok: true };
}

async function runOpenAITest(apiKey, modelId) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${_TEST_PNG}` } },
        { type: 'text', text: '连接测试，只回复 OK' }
      ]}],
      max_tokens: 10,
      temperature: 0
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data.error?.message || JSON.stringify(data.error) || `HTTP ${resp.status}`;
    return { ok: false, error: `[${resp.status}] ${msg}` };
  }
  return { ok: true };
}

async function runDeepSeekTest(apiKey, modelId) {
  // DeepSeek 标准 API 以文本测试为主（视觉模型按实际情况返回结果）
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: '连接测试，只回复 OK' }],
      max_tokens: 10,
      temperature: 0
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data.error?.message || JSON.stringify(data.error) || `HTTP ${resp.status}`;
    return { ok: false, error: `[${resp.status}] ${msg}` };
  }
  return { ok: true };
}

// ============================================================
//  工具：设置模型失败状态
// ============================================================
function setModelFail(dot, errTxt, errRow, errorMsg) {
  dot.className = 'model-status-dot fail';
  dot.title = '连通性测试失败 ✗';
  errTxt.textContent = errorMsg;
  errTxt.dataset.full = errorMsg;
  errRow.classList.remove('hidden');
}

// ============================================================
//  工具：复制文本
// ============================================================
function copyText(text, btn) {
  const doFlash = () => {
    const orig = btn.textContent;
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(doFlash).catch(() => {
      legacyCopy(text); doFlash();
    });
  } else {
    legacyCopy(text); doFlash();
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ============================================================
//  通用 UI 工具
// ============================================================
function showLoading(id, on) { $(id).classList.toggle('hidden', !on); }
function showError(msg) { const el = $('error-box'); el.textContent = msg; el.classList.remove('hidden'); }
function hideError() { $('error-box').classList.add('hidden'); }
