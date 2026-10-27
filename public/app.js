// Nimbus web app. Plain JS, no build step.
import { attachAutocorrect } from './autocorrect.js';
import { THEMES, resolveTheme, applyThemeVars } from './themes.js';
import { startRecording, stopRecording, cancelRecording, isRecording, browserDictation } from './dictation.js';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const BOT_COLORS = ['#f4f6ff', '#c7e3ff', '#d9d1ff', '#ffd3e0', '#ffe6a8', '#c9f2d8', '#ffcfb0', '#8fb8ff', '#b39dff', '#ff9fb5', '#7fd6c2', '#9aa3ad',
  '#ff6b6b', '#ff9f43', '#feca57', '#a3e635', '#2ed573', '#1dd1a1', '#48dbfb', '#54a0ff', '#5f27cd', '#c56cf0', '#ff7eb3', '#576574', '#f5e6d3', '#8d6e63', '#2d3436', '#ffffff'];
const svg = (d, w = 18) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  send: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 16),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  book: svg('<path d="M5 4.5h10a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>'),
  plug: svg('<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>'),
  compose: svg('<path d="M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 14),
  check: svg('<path d="m5 12 5 5 9-10"/>', 14),
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>', 14),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  clip: svg('<path d="m20 11.5-8.3 8.3a5 5 0 0 1-7-7l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7l-8.8 8.8a1.7 1.7 0 0 1-2.4-2.4l8.1-8.1"/>'),
  monitor: svg('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>')
};

const S = { data: null, current: null, messages: [], loadingThread: false, market: null };

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.querySelectorAll('.toast').forEach((o) => o.remove()); // newest wins, no pile-up
  document.body.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 2600);
}

// A light tap on phones (Android browsers and the Nimbus app); ignored elsewhere.
const buzz = (ms = 8) => { try { if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(ms); } catch {} };

// ---------- theme ----------
function getPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('nimbus.appearance')) || {}; } catch {}
  // Older settings had { mode: dark|light|system, accent } and no theme.
  if (!p.theme) { p.theme = p.mode || 'dark'; if (p.accent === '#3b82f6') delete p.accent; } // old default accent: use the theme's
  return p;
}
function applyTheme() {
  const p = getPrefs();
  const theme = resolveTheme(p, matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]').content = applyThemeVars(document.documentElement, theme, p.accent);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- helpers ----------
const bot = (id) => S.data?.bots.find((b) => b.id === Number(id));
const room = (id) => S.data?.rooms.find((r) => r.id === Number(id));
const threadKey = () => S.current ? `${S.current.type}:${S.current.id}` : null;
// A bot's look is stored in `shape` as "hat/glasses/body/face/extra". Older bots only have
// "hat/glasses"; the missing parts fall back to the original cloud with a smile.
const HATS = ['none', 'cap', 'beanie', 'tophat', 'crown', 'party', 'headphones', 'halo', 'wizard', 'chef', 'cowboy', 'bow', 'flower', 'horns', 'antenna', 'santa', 'sprout'];
const GLASSES = ['none', 'shades', 'specs', 'monocle', 'visor', '3d', 'round', 'heart', 'star', 'eyepatch', 'goggles'];
const BODIES = ['cloud', 'blob', 'ghost', 'box', 'cat'];
const FACES = ['smile', 'happy', 'wink', 'surprised', 'sleepy', 'cat', 'tongue', 'mustache', 'grumpy'];
const EXTRAS = ['none', 'bowtie', 'scarf', 'tie', 'sparkles', 'hearts', 'badge'];
const LOOK_PARTS = [['body', BODIES, 'Body'], ['face', FACES, 'Face'], ['hat', HATS, 'Hat'], ['glasses', GLASSES, 'Glasses'], ['extra', EXTRAS, 'Extra']];
const px = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
function outfit(b) {
  const [hat, glasses, body, face, extra] = String(b?.shape || '').split('/');
  const pick = (v, list) => (list.includes(v) ? v : list[0]);
  return { hat: pick(hat, HATS), glasses: pick(glasses, GLASSES), body: pick(body, BODIES), face: pick(face, FACES), extra: pick(extra, EXTRAS) };
}
const lookShape = (l) => [l.hat, l.glasses, l.body, l.face, l.extra].join('/');

// Body outlines as [row, firstCol, lastCol] spans on the 14x14 grid; eyes and cheeks sit on rows 6-8 for every body.
const BODY_ROWS = {
  cloud: { rows: [[2, 4, 6], [3, 3, 7], [3, 9, 10], [4, 2, 11], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 5], [9, 7, 11]], feet: true },
  blob: { rows: [[2, 5, 8], [3, 3, 10], [4, 2, 11], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 11]], feet: true },
  ghost: { rows: [[2, 4, 9], [3, 3, 10], [4, 2, 11], [5, 2, 11], [6, 2, 11], [7, 2, 11], [8, 2, 11], [9, 2, 11], [10, 2, 3], [10, 5, 6], [10, 8, 9], [10, 11, 11]], feet: false },
  box: { rows: [[3, 2, 11], [4, 1, 12], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 11]], feet: true },
  cat: { rows: [[1, 2, 3], [1, 10, 11], [2, 2, 4], [2, 9, 11], [3, 2, 11], [4, 1, 12], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 5], [9, 7, 11]], feet: true }
};

function critter(color, look = {}, legacyGlasses) {
  if (typeof look === 'string') look = { hat: look, glasses: legacyGlasses }; // old (color, hat, glasses) calls
  const { hat = 'none', glasses = 'none', body = 'cloud', face = 'smile', extra = 'none' } = look;
  const c = esc(color || '#f4f6ff'), ink = '#16204a', shade = ' opacity=".12"';
  const B = BODY_ROWS[body] || BODY_ROWS.cloud;
  const feet = B.feet ? [[4, 10, 2], [8, 10, 2]] : [];
  const bottom = Math.max(...B.rows.map((r) => r[0]));
  let s = B.rows.map(([y, a, z]) => px(a - 0.5, y - 0.5, z - a + 2, 2, ink)).join('')
    + feet.map(([x, y, w]) => px(x - 0.5, y - 0.2, w + 1, 1.7, ink)).join('')
    + B.rows.map(([y, a, z]) => px(a, y, z - a + 1, 1, c)).join('')
    + feet.map(([x, y, w]) => px(x, y, w, 1, c)).join('')
    + B.rows.filter(([y]) => y === bottom).map(([y, a, z]) => px(a, y, z - a + 1, 1, ink, shade)).join('')
    + px(4.3, (B.rows[0][0]) + 0.3, 1.2, 0.5, '#fff', ' opacity=".8"');
  if (body === 'box') s += px(6.5, 1, 1, 2, ink) + px(6.1, 0.4, 1.8, 1, '#f5c542');
  if (body === 'cat') s += px(2.6, 1.6, 0.8, 0.8, '#f59bb0') + px(10.6, 1.6, 0.8, 0.8, '#f59bb0');

  // Face: eyes, cheeks and mouth.
  const eye = (x) => px(x, 6, 1.3, 1.5, ink) + px(x + 0.4, 6.2, 0.45, 0.45, '#fff');
  const closed = (x) => px(x - 0.1, 6.7, 1.5, 0.45, ink);
  const arc = (x) => px(x, 6.4, 0.45, 0.45, ink) + px(x + 0.4, 6, 0.6, 0.45, ink) + px(x + 0.9, 6.4, 0.45, 0.45, ink);
  const cheeks = px(2.4, 7.7, 1.1, 0.6, '#f59bb0') + px(10.5, 7.7, 1.1, 0.6, '#f59bb0');
  const smile = px(6.1, 7.6, 0.4, 0.4, ink) + px(6.5, 8, 1, 0.4, ink) + px(7.5, 7.6, 0.4, 0.4, ink);
  s += cheeks + {
    smile: eye(3.8) + eye(8.9) + smile,
    happy: arc(3.8) + arc(8.9) + px(6.1, 7.6, 1.8, 0.5, ink) + px(6.4, 8.1, 1.2, 0.5, '#e2475f'),
    wink: eye(3.8) + arc(8.9) + smile,
    surprised: eye(3.8) + eye(8.9) + px(6.4, 7.6, 1.2, 1.2, ink),
    sleepy: closed(3.8) + closed(8.9) + px(6.5, 8, 1, 0.4, ink) + px(11.6, 3.2, 0.9, 0.3, ink) + px(12.2, 2.9, 0.3, 0.3, ink) + px(11.6, 2.6, 0.9, 0.3, ink),
    cat: eye(3.8) + eye(8.9) + px(5.9, 7.7, 0.4, 0.4, ink) + px(6.3, 8.1, 0.6, 0.4, ink) + px(6.8, 7.7, 0.4, 0.4, ink) + px(7.1, 8.1, 0.6, 0.4, ink) + px(7.6, 7.7, 0.4, 0.4, ink),
    tongue: eye(3.8) + eye(8.9) + smile + px(6.6, 8.3, 0.8, 0.7, '#e2475f'),
    mustache: eye(3.8) + eye(8.9) + px(5.3, 7.6, 3.4, 0.6, '#5a3a22') + px(4.9, 7.9, 0.6, 0.5, '#5a3a22') + px(8.5, 7.9, 0.6, 0.5, '#5a3a22'),
    grumpy: eye(3.8) + eye(8.9) + px(3.6, 5.4, 1.5, 0.35, ink) + px(8.9, 5.4, 1.5, 0.35, ink) + px(6.1, 8, 0.4, 0.4, ink) + px(6.5, 7.7, 1, 0.4, ink) + px(7.5, 8, 0.4, 0.4, ink)
  }[face];

  const E = 6, L = 3.3, R = 8.4;
  const heart = (x, y, f) => px(x, y, 0.8, 0.8, f) + px(x + 1.2, y, 0.8, 0.8, f) + px(x - 0.2, y + 0.5, 2.4, 0.8, f) + px(x + 0.3, y + 1.2, 1.4, 0.6, f) + px(x + 0.7, y + 1.7, 0.6, 0.4, f);
  const star = (x, y, f, k = 1) => px(x + 0.8 * k, y, 0.6 * k, 2.2 * k, f) + px(x, y + 0.8 * k, 2.2 * k, 0.6 * k, f) + px(x + 0.4 * k, y + 0.4 * k, 1.4 * k, 1.4 * k, f);
  s += {
    none: '',
    shades: px(L, E - 0.2, 2.4, 1.8, '#111') + px(R, E - 0.2, 2.4, 1.8, '#111') + px(L + 2.4, E + 0.3, R - L - 2.4, 0.45, '#111') + px(L + 0.3, E + 0.1, 0.7, 0.35, '#fff', ' opacity=".55"') + px(R + 0.3, E + 0.1, 0.7, 0.35, '#fff', ' opacity=".55"'),
    specs: `<g fill="rgba(255,255,255,.25)" stroke="${ink}" stroke-width=".4">${px(L, E - 0.3, 2.4, 2, '')}${px(R, E - 0.3, 2.4, 2, '')}</g>` + px(L + 2.4, E + 0.4, R - L - 2.4, 0.4, ink),
    monocle: `<rect x="${R - 0.1}" y="${E - 0.4}" width="2.6" height="2.2" rx="1" fill="rgba(255,255,255,.25)" stroke="#f5c542" stroke-width=".4"/>` + px(R + 2.2, E + 1.8, 0.4, 2, '#f5c542'),
    visor: px(1.5, E - 0.4, 11, 2.1, '#48d6f0') + px(1.5, E - 0.4, 11, 0.55, '#b8f3ff') + px(3.8, E + 0.1, 1.3, 1.1, '#0b3a44', ' opacity=".55"') + px(8.9, E + 0.1, 1.3, 1.1, '#0b3a44', ' opacity=".55"'),
    '3d': `<g stroke="#f4f4f4" stroke-width=".4">${px(L, E - 0.3, 2.4, 2, '#e2475f')}${px(R, E - 0.3, 2.4, 2, '#3fb6e8')}</g>` + px(L + 2.4, E + 0.4, R - L - 2.4, 0.4, '#f4f4f4'),
    round: `<g fill="rgba(255,255,255,.2)" stroke="#b07a3b" stroke-width=".45"><circle cx="${L + 1.2}" cy="${E + 0.7}" r="1.35"/><circle cx="${R + 1.2}" cy="${E + 0.7}" r="1.35"/></g>` + px(L + 2.5, E + 0.5, R - L - 2.6, 0.35, '#b07a3b'),
    heart: heart(L + 0.2, E - 0.3, '#e84fa0') + heart(R + 0.2, E - 0.3, '#e84fa0') + px(L + 2.4, E + 0.3, R - L - 2.4, 0.4, '#e84fa0'),
    star: star(L + 0.1, E - 0.5, '#f5c542') + star(R + 0.1, E - 0.5, '#f5c542') + px(L + 2.3, E + 0.4, R - L - 2.2, 0.4, '#f5c542'),
    eyepatch: px(R - 0.1, E - 0.4, 2.6, 2.2, '#111') + px(1, E - 1.6, R - 1, 0.4, '#111') + px(R + 2.5, E - 0.4, 2, 0.4, '#111'),
    goggles: px(1.2, E + 0.2, 11.6, 0.6, '#5a3a22') + `<g stroke="#8a8f98" stroke-width=".5" fill="#9be7c4" fill-opacity=".55">${px(L - 0.2, E - 0.5, 2.8, 2.4, '')}${px(R - 0.2, E - 0.5, 2.8, 2.4, '')}</g>`
  }[glasses] || '';

  const X = 5.5, T = (B.rows[0][0] === 1 ? 2 : B.rows[0][0]) + 1; // hat centre and the top of the body
  s += {
    none: '',
    cap: px(X - 2.5, T - 1.6, 5, 1.9, '#2f6fed') + px(X + 1.5, T - 0.2, 4, 0.9, '#2356c4') + px(X - 0.5, T - 2, 1, 0.5, '#2356c4'),
    beanie: px(X - 2.5, T - 2.2, 5, 1.8, '#1f9d6b') + px(X - 3, T - 0.6, 6, 1, '#167a52') + px(X - 0.5, T - 3.1, 1, 1, '#f4f4f4'),
    tophat: px(X - 1.8, T - 4, 3.6, 3.4, '#1b1b1b') + px(X - 1.8, T - 1.4, 3.6, 0.6, '#e2475f') + px(X - 2.9, T - 0.6, 5.8, 0.9, '#1b1b1b'),
    crown: px(X - 2.5, T - 1, 5, 1.1, '#f5c542') + px(X - 2.5, T - 2.1, 1, 1.1, '#f5c542') + px(X - 0.5, T - 2.5, 1, 1.5, '#f5c542') + px(X + 1.5, T - 2.1, 1, 1.1, '#f5c542') + px(X - 0.5, T - 0.8, 1, 0.7, '#e2475f'),
    party: px(X - 2, T - 0.8, 4, 1, '#e84fa0') + px(X - 1.5, T - 1.8, 3, 1, '#f5c542') + px(X - 1, T - 2.8, 2, 1, '#e84fa0') + px(X - 0.5, T - 3.8, 1, 1, '#3fb6e8'),
    headphones: px(2.2, T - 0.3, 9.6, 0.7, '#262626') + px(1.6, T + 0.2, 0.8, 2.5, '#262626') + px(11.6, T + 0.2, 0.8, 2.5, '#262626') + px(0.2, 5, 1.8, 2.6, '#262626') + px(12, 5, 1.8, 2.6, '#262626'),
    halo: `<ellipse cx="${X + 3}" cy="${T - 1.6}" rx="2.8" ry=".8" fill="none" stroke="#8b93f5" stroke-width=".55"/>`,
    wizard: px(X - 3, T - 0.6, 6.5, 0.9, '#5b3fc4') + px(X - 2, T - 1.6, 4.5, 1, '#6b4fe0') + px(X - 1.2, T - 2.6, 3, 1, '#6b4fe0') + px(X - 0.4, T - 3.6, 1.8, 1, '#6b4fe0') + px(X + 0.6, T - 4.3, 1.2, 0.8, '#6b4fe0') + px(X - 1, T - 1.4, 0.6, 0.6, '#f5c542') + px(X + 1.2, T - 2.4, 0.5, 0.5, '#f5c542'),
    chef: px(X - 2.2, T - 1.2, 4.4, 1.4, '#f4f4f4') + px(X - 2.6, T - 3, 1.9, 1.9, '#f4f4f4') + px(X - 1, T - 3.5, 2, 2.4, '#f4f4f4') + px(X + 0.7, T - 3, 1.9, 1.9, '#f4f4f4') + px(X - 2.2, T - 0.2, 4.4, 0.4, '#c9ccd4'),
    cowboy: px(X - 4, T - 0.4, 8, 0.9, '#8a5a2b') + px(X - 4.4, T - 0.9, 1, 0.7, '#8a5a2b') + px(X + 3.4, T - 0.9, 1, 0.7, '#8a5a2b') + px(X - 2, T - 2.6, 4, 2.3, '#a86d35') + px(X - 2, T - 1, 4, 0.5, '#5a3a22'),
    bow: px(X + 1.5, T - 1.2, 1.6, 1.8, '#e84fa0') + px(X + 4, T - 1.2, 1.6, 1.8, '#e84fa0') + px(X + 3, T - 0.8, 1.1, 1.1, '#c23a84'),
    flower: px(X + 2.6, T - 2.4, 1.1, 1.1, '#ff9fb5') + px(X + 1.5, T - 1.3, 1.1, 1.1, '#ff9fb5') + px(X + 3.7, T - 1.3, 1.1, 1.1, '#ff9fb5') + px(X + 2.6, T - 0.2, 1.1, 1.1, '#ff9fb5') + px(X + 2.6, T - 1.3, 1.1, 1.1, '#f5c542'),
    horns: px(2.2, T - 1, 1.2, 1.2, '#e2475f') + px(1.6, T - 2.2, 1, 1.4, '#e2475f') + px(10.6, T - 1, 1.2, 1.2, '#e2475f') + px(11.4, T - 2.2, 1, 1.4, '#e2475f'),
    antenna: px(X + 1.2, T - 3, 0.5, 3, ink) + px(X + 0.8, T - 4, 1.3, 1.3, '#48d6f0') + px(X + 1, T - 3.8, 0.4, 0.4, '#fff'),
    santa: px(X - 2.6, T - 0.6, 5.6, 1.1, '#f4f4f4') + px(X - 2, T - 2, 4.4, 1.5, '#e2475f') + px(X - 0.6, T - 3, 3, 1.1, '#e2475f') + px(X + 2, T - 2.6, 1.1, 1.1, '#e2475f') + px(X + 2.8, T - 2.2, 1.1, 1.1, '#f4f4f4'),
    sprout: px(X + 1.3, T - 2, 0.45, 2, '#1f9d6b') + px(X - 0.2, T - 2.8, 1.5, 0.9, '#3ccf8e') + px(X + 1.7, T - 3.3, 1.7, 1, '#3ccf8e')
  }[hat] || '';

  s += {
    none: '',
    bowtie: px(5.2, 8.9, 1.5, 1.2, '#e2475f') + px(7.3, 8.9, 1.5, 1.2, '#e2475f') + px(6.6, 9.1, 0.8, 0.8, '#b8324a'),
    scarf: px(1.5, 8.6, 11, 1, '#f08a3c') + px(9, 9.4, 1.4, 2, '#f08a3c') + px(9, 10.9, 1.4, 0.4, '#c96a26') + px(3, 8.6, 0.5, 1, '#c96a26', ' opacity=".6"') + px(6, 8.6, 0.5, 1, '#c96a26', ' opacity=".6"'),
    tie: px(6.4, 8.7, 1.2, 0.8, '#2f6fed') + px(6.2, 9.4, 1.6, 1.6, '#2f6fed') + px(6.6, 10.9, 0.8, 0.5, '#2f6fed'),
    sparkles: star(11.2, 0.6, '#f5c542', 0.8) + star(0.4, 2.6, '#f5c542', 0.6) + px(12.6, 4.4, 0.5, 0.5, '#f5c542'),
    hearts: heart(11.3, 1, '#e84fa0') + heart(0.5, 2.8, '#ff9fb5'),
    badge: `<circle cx="10.2" cy="9.3" r="1.1" fill="#f5c542" stroke="${ink}" stroke-width=".3"/>` + px(9.9, 9, 0.6, 0.6, '#e2475f')
  }[extra] || '';
  return s;
}
function avatar(b, size = 36) {
  if (!b) b = { color: '#9aa3ad' };
  return `<span class="avatar" style="width:${size}px;height:${size}px;--c:${esc(b.color)};border-radius:${Math.round(size * 0.28)}px"><svg viewBox="0 0 14 14" width="${Math.round(size * 0.86)}" height="${Math.round(size * 0.86)}" shape-rendering="crispEdges" aria-hidden="true">${critter(b.color, outfit(b))}</svg></span>`;
}
function roomAvatar(r, size = 36) {
  const m = r.members.slice(0, 2).map((id) => bot(id));
  if (m.length < 2) return avatar(m[0], size);
  const s = Math.round(size * 0.66);
  return `<span class="avatar stack" style="width:${size}px;height:${size}px"><span style="left:0;top:0">${avatar(m[0], s)}</span><span style="right:0;bottom:0">${avatar(m[1], s)}</span></span>`;
}
function stamp(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], now - d < 6 * 864e5 ? { weekday: 'long' } : { month: 'short', day: 'numeric' });
}
function timeAgo(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'now'; if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h'; return Math.floor(d / 86400) + 'd';
}
function clock(sec) { return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function whenNext(ms) {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  if (d.toDateString() === now.toDateString()) return t;
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return 'Tmr ' + t;
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
}
function md(src) {
  const blocks = String(src ?? '').split(/```/);
  return blocks.map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^\w*\n/, ''))}</code></pre>`;
    return part.trim().split(/\n{2,}/).map((para) => {
      let h = esc(para)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
        .replace(/(^|\s)@([A-Z][\w]*(?: [A-Z][\w]*)?)/g, '$1<strong class="mention">@$2</strong>');
      if (/^\s*[-*] /m.test(para) && para.split('\n').every((l) => /^\s*[-*] /.test(l) || !l.trim())) {
        return '<ul>' + h.split('\n').filter((l) => l.trim()).map((l) => `<li>${l.replace(/^\s*[-*] /, '')}</li>`).join('') + '</ul>';
      }
      return `<p>${h.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }).join('');
}
function userName() {
  const e = S.data?.user?.email || '';
  const n = e.split('@')[0] || 'You';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// ---------- sidebar ----------
let sideQuery = '';
function renderSide() {
  const d = S.data;
  const key = threadKey();
  const items = [
    ...d.bots.map((b) => ({ key: 'bot:' + b.id, name: b.name, av: avatar(b, 38), state: b.status.state, last: d.last['bot:' + b.id], fallback: b.role, created: b.created_at })),
    ...d.rooms.map((r) => ({ key: 'room:' + r.id, name: r.name, av: roomAvatar(r, 38), state: r.members.some((id) => bot(id)?.status.state === 'working') ? 'working' : 'idle', last: d.last['room:' + r.id], fallback: `${r.members.length} bots`, created: r.created_at }))
  ].filter((it) => !sideQuery || it.name.toLowerCase().includes(sideQuery))
    .sort((a, b) => (b.last?.at || b.created || 0) - (a.last?.at || a.created || 0));
  // Your own order (from dragging) wins; chats not placed yet stay on top, newest first.
  if (d.sideOrder) {
    const pos = new Map(d.sideOrder.map((k, i) => [k, i]));
    items.sort((a, b) => (pos.has(a.key) ? pos.get(a.key) : -1) - (pos.has(b.key) ? pos.get(b.key) : -1));
  }
  const pending = d.approvals.length;
  $('#side').innerHTML = `
    <div class="side-top">
      <label class="search">${ICON.search}<input id="side-search" placeholder="Search" value="${esc(sideQuery)}" autocomplete="off"></label>
      <button class="icon-btn" data-act="new-menu" aria-label="New">${ICON.plus}</button>
    </div>
    <div class="side-list">
      ${items.length ? items.map((it) => `
        <button class="side-item ${key === it.key ? 'active' : ''}" data-open="${it.key}" data-key="${it.key}">
          <span class="av-wrap">${it.av}${it.state !== 'idle' ? `<span class="dot ${it.state}"></span>` : ''}</span>
          <span class="meta">
            <span class="row1"><span class="name">${esc(it.name)}</span><span class="time">${it.last ? stamp(it.last.at) : ''}</span></span>
            <span class="sub">${esc(it.last ? (it.last.author === 'user' ? 'You: ' : '') + it.last.text : it.fallback || 'Say hi')}</span>
          </span>
        </button>`).join('') + (sideQuery ? '' : d.sideOrder ? '<button class="side-reset" data-act="side-recent">↺ Sort by recent activity</button>'
          : items.length > 1 ? '<div class="side-hint">Tip: drag chats to arrange them</div>' : '')
        : sideQuery ? '<div class="side-empty">No chats match</div>'
        : `<div class="side-empty">No bots yet.<br><button class="link" data-act="market">Browse the Marketplace</button> or <button class="link" data-act="new-bot">make one</button>.</div>`}
    </div>
    ${sideQuery.length >= 2 ? `<div class="side-hits" id="side-hits"><div class="side-empty">Searching messages…</div></div>` : ''}
    <div class="side-foot">
      ${pending ? `<button class="foot-item" data-act="panel">${ICON.bell}<span>Approvals</span><span class="badge">${pending}</span></button>` : ''}
      <button class="foot-item" data-act="market">${ICON.grid}<span>Marketplace</span></button>
      <button class="foot-item user" data-act="user-menu"><span class="initial">${esc(userName()[0])}</span><span>${esc(userName())}</span></button>
    </div>`;
}

const _renderSide = renderSide;
renderSide = function () {
  if (drag?.started) return; // don't rebuild the list under your finger mid-drag
  _renderSide(); if (sideQuery.length >= 2) searchMessages(); // keep message hits after re-renders
};

// ---------- drag to reorder the sidebar ----------
// Mouse: press and move. Touch: hold for a moment, then drag (a quick swipe still scrolls the list).
// The order is saved on the server, so it's the same on every device.
let drag = null; // { item, list, startY, grabDy, ty, started, timer, touch }
let suppressClickUntil = 0;
document.addEventListener('click', (e) => { if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); } }, true);
function dragBegin(item, y, touch) {
  if (sideQuery) return; // the list is filtered while searching
  drag = { item, list: item.parentElement, startY: y, started: false, touch };
  if (touch) drag.timer = setTimeout(() => dragStart(y), 320);
}
function dragStart(y) {
  if (!drag) return;
  drag.started = true;
  const r = drag.item.getBoundingClientRect();
  drag.grabDy = y - r.top;
  drag.item.classList.add('dragging');
  document.body.classList.add('reordering');
  buzz(12);
}
function dragMove(y) {
  if (!drag) return;
  if (!drag.started) {
    if (Math.abs(y - drag.startY) < 6) return;
    if (drag.touch) { clearTimeout(drag.timer); drag = null; return; } // moved before the hold: it's a scroll
    dragStart(drag.startY);
  }
  const { item, list } = drag;
  // Follow the pointer, then swap with a neighbour once the pointer passes its middle.
  const siblings = [...list.querySelectorAll('.side-item:not(.dragging)')];
  const target = siblings.find((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
  const before = siblings.map((el) => [el, el.getBoundingClientRect().top]);
  const next = item.nextElementSibling?.classList.contains('side-item') ? item.nextElementSibling : null;
  if ((target || null) !== next) {
    list.insertBefore(item, target || siblings.at(-1)?.nextSibling || null);
    // Slide the others into their new places (FLIP).
    for (const [el, top] of before) {
      const dy = top - el.getBoundingClientRect().top;
      if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
  }
  const natural = item.getBoundingClientRect().top - (drag.ty || 0); // where it sits without the offset
  drag.ty = y - drag.grabDy - natural;
  item.style.transform = `translateY(${drag.ty}px) scale(1.03)`;
  // Scroll the list when dragging near its edges.
  const lr = list.getBoundingClientRect();
  if (y < lr.top + 40) list.scrollTop -= 8; else if (y > lr.bottom - 40) list.scrollTop += 8;
}
async function dragEnd() {
  if (!drag) return;
  clearTimeout(drag.timer);
  const was = drag; drag = null;
  if (!was.started) return;
  was.item.classList.remove('dragging'); was.item.style.transform = '';
  document.body.classList.remove('reordering');
  suppressClickUntil = Date.now() + 400; // the click that follows a drag shouldn't open the chat
  const order = [...was.list.querySelectorAll('.side-item')].map((el) => el.dataset.key);
  S.data.sideOrder = order;
  renderSide();
  try { await api('/api/side-order', { method: 'PUT', body: { order } }); } catch (err) { toast(err.message); }
}
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  const item = e.target.closest('.side-list .side-item'); if (item) dragBegin(item, e.clientY, false);
});
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && drag) { dragMove(e.clientY); if (drag?.started) e.preventDefault(); } });
document.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') dragEnd(); });
document.addEventListener('touchstart', (e) => {
  const item = e.target.closest('.side-list .side-item'); if (item && e.touches.length === 1) dragBegin(item, e.touches[0].clientY, true);
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!drag) return;
  dragMove(e.touches[0].clientY);
  if (drag?.started) e.preventDefault(); // holding a chat: move it instead of scrolling
}, { passive: false });
document.addEventListener('touchend', dragEnd);
document.addEventListener('touchcancel', dragEnd);
document.addEventListener('contextmenu', (e) => { if (drag?.touch) e.preventDefault(); }); // no long-press menu while holding

// ---------- activity drawer ----------
function renderAside() {
  const d = S.data;
  const pct = d.usage.budget ? Math.min(100, Math.round((d.usage.windowCost / d.usage.budget) * 100)) : null;
  $('#aside').innerHTML = `
    <div class="aside-head"><b>Activity</b><button class="icon-btn" data-act="panel" aria-label="Close">${ICON.close}</button></div>
    <section>
      <h4>Approvals ${d.approvals.length ? `<span class="badge">${d.approvals.length}</span>` : ''}</h4>
      ${d.approvals.length ? d.approvals.map((a) => `
        <button class="card-item" data-open="${esc(a.thread)}">${avatar(bot(a.bot_id), 26)}<span><small>${esc(bot(a.bot_id)?.name)} · ${timeAgo(a.created_at)}</small>${esc(describeTool(a.tool, a.input))}</span></button>`).join('')
        : '<div class="muted">Nothing waiting on you.</div>'}
    </section>
    <section>
      <h4>Up next</h4>
      ${d.upNext.length ? d.upNext.map((r) => `<div class="sched"><span>${whenNext(r.next)}</span><span>${esc(bot(r.bot_id)?.name)} · ${esc(r.prompt.slice(0, 60))}</span></div>`).join('')
        : '<div class="muted">No routines yet.</div>'}
    </section>
    <section>
      <h4>Learned recently</h4>
      ${d.learned.length ? d.learned.map((l) => `<div class="learned">“${esc(l.text)}” <span class="muted">· ${esc(bot(l.botId)?.name)}</span></div>`).join('')
        : '<div class="muted">When you tell a bot a rule, it shows up here.</div>'}
    </section>
    ${d.computers ? '<section id="comp-box"><h4>Bot computers</h4><div class="muted">Loading…</div></section>' : ''}
    ${d.proxmox ? '<section id="pve-box"><h4>Proxmox</h4><div class="muted">Loading…</div></section>' : ''}
    ${d.usage.byBot?.length ? `<section><h4>Usage by bot · 7 days</h4>${(() => { const total = d.usage.byBot.reduce((a, x) => a + x.cost, 0) || 1;
      return d.usage.byBot.slice(0, 6).map((x) => { const b = bot(x.bot_id); const pc = Math.round((x.cost / total) * 100);
        return `<div class="ubot">${avatar(b, 20)}<span class="un">${esc(b?.name || 'Deleted bot')}</span><span class="muted">${x.runs} runs · ${b ? esc(EFFORTS.find((e) => e[0] === b.effort)?.[1] || b.effort) : ''}</span><b>${pc}%</b></div>
          <div class="meter thin"><div style="width:${pc}%"></div></div>`; }).join(''); })()}
      <div class="muted small">Heavy bots on High or Max effort usually do fine on Medium for routine work.</div></section>` : ''}
    <section class="usage" id="usage-box">${usageFallback(d, pct)}</section>`;
  loadPlanUsage();
  if (d.proxmox) loadProxmox();
  if (d.computers) loadComputers();
}

// Plan usage: the real % of your Claude plan's limits left (like /usage in Claude Code).
// Falls back to the old cost estimate if Anthropic's usage check isn't available.
function usageFallback(d, pct) {
  return (pct != null ? `<div class="row"><span>Usage, last 5 hours</span><span>${pct}%</span></div><div class="meter"><div style="width:${pct}%"></div></div>`
    : `<div class="row"><span>Est. usage, last 5 hours</span><span>$${d.usage.windowCost.toFixed(2)}</span></div>`)
    + `<div class="muted">${d.usage.running} running · ${d.bots.filter((b) => b.status.state === 'working').length} bots busy</div>`;
}
let planLast = null, planAt = 0;
async function loadPlanUsage() {
  if (planLast) drawPlanUsage(planLast);
  if (Date.now() - planAt < 60_000) return;
  planAt = Date.now();
  try { planLast = await api('/api/plan-usage'); } catch { planLast = { ok: false }; }
  drawPlanUsage(planLast);
}
function resetsIn(iso) {
  const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(iso).toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function drawPlanUsage(p) {
  const box = $('#usage-box'); if (!box || !p?.ok) return;
  const d = S.data;
  box.innerHTML = `<h4>Claude plan${p.plan ? ` · ${esc(p.plan[0].toUpperCase() + p.plan.slice(1))}` : ''}</h4>` + p.windows.map((w) => {
    const left = Math.max(0, Math.round(100 - w.used));
    return `<div class="row"><span>${esc(w.label)}</span><span><b>${left}% left</b></span></div>
      <div class="meter ${w.used >= 90 ? 'hot' : w.used >= 70 ? 'warm' : ''}"><div style="width:${Math.min(100, w.used)}%"></div></div>
      <div class="muted small">${Math.round(w.used)}% used${w.resets ? ` · resets in ${resetsIn(w.resets)}` : ''}</div>`;
  }).join('') + `<div class="muted">${d.usage.running} running · ${d.bots.filter((b) => b.status.state === 'working').length} bots busy</div>`;
}

// Bot computers: which are awake or asleep, their memory, and the VM's memory.
let compLast = null, compAt = 0;
async function loadComputers() {
  if (compLast) drawComputers(compLast);
  if (Date.now() - compAt < 15000) return;
  compAt = Date.now();
  try { compLast = await api('/api/computers'); } catch (err) { compLast = { error: err.message }; }
  drawComputers(compLast);
}
function drawComputers(c) {
  const box = $('#comp-box'); if (!box) return;
  if (c.error) { box.innerHTML = `<h4>Bot computers</h4><div class="muted">Couldn’t reach the computer VM: ${esc(c.error)}</div>`; return; }
  const pct = c.vm ? Math.round((c.vm.memUsed / c.vm.memTotal) * 100) : 0;
  box.innerHTML = `<h4>Bot computers</h4>
    ${(c.computers || []).length ? c.computers.map((x) => `<button class="card-item comp-row" data-computer="${x.bot}">${avatar(bot(x.bot), 26)}
      <span><small>${x.running ? `<span class="dot-inline on"></span>Awake${x.mem ? ` · ${esc(x.mem)}` : ''}` : '<span class="dot-inline"></span>Asleep'}</small>${esc(bot(x.bot)?.name || 'Bot ' + x.bot)}</span></button>`).join('')
      : '<div class="muted">No bot has its own computer yet.</div>'}
    ${c.vm ? `<div class="row"><span>VM memory</span><span>${(c.vm.memUsed / 2 ** 30).toFixed(1)} of ${(c.vm.memTotal / 2 ** 30).toFixed(1)} GB</span></div>
      <div class="meter ${pct >= 90 ? 'hot' : pct >= 75 ? 'warm' : ''}"><div style="width:${pct}%"></div></div>` : ''}
    ${c.sleepAfterMin ? `<div class="muted small">Idle computers sleep after ${c.sleepAfterMin >= 60 ? c.sleepAfterMin / 60 + ' h' : c.sleepAfterMin + ' min'}.</div>` : ''}`;
}

// Host load and guest status, fetched separately so a slow Proxmox never delays the app.
let pveLast = null, pveAt = 0;
async function loadProxmox() {
  if (pveLast) drawProxmox(pveLast);
  if (Date.now() - pveAt < 15000) return;
  pveAt = Date.now();
  try { pveLast = await api('/api/proxmox'); } catch (err) { pveLast = { error: err.message }; }
  drawProxmox(pveLast);
}
function drawProxmox(p) {
  const box = $('#pve-box'); if (!box) return;
  const pc = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const meter = (label, v) => `<div class="row"><span>${label}</span><span>${v}%</span></div><div class="meter"><div style="width:${v}%"></div></div>`;
  const down = (p.guests || []).filter((g) => g.status !== 'running');
  box.innerHTML = `<h4>Proxmox</h4>${p.error ? `<div class="muted">Couldn’t reach Proxmox: ${esc(p.error)}</div>`
    : (p.nodes || []).map((n) => `<div class="pve-node"><b>${esc(n.name)}</b> <span class="muted">${n.status === 'online' ? `up ${Math.floor(n.uptime / 86400)}d` : esc(n.status)}</span>
        ${meter('CPU', Math.round(n.cpu * 100))}${meter('Memory', pc(n.mem, n.maxmem))}${meter('Root disk', pc(n.disk, n.maxdisk))}</div>`).join('')
      + `<div class="muted">${(p.guests || []).length - down.length} of ${(p.guests || []).length} guests running</div>`
      + down.map((g) => `<div class="sched"><span>${esc(g.status)}</span><span>${g.id} · ${esc(g.name)}</span></div>`).join('')}`;
}
function describeTool(tool, input = {}) {
  if (tool === 'Bash') return 'Run: ' + String(input.command || '').slice(0, 80);
  const pretty = tool.replace(/^mcp__/, '').replace(/__/g, ' › ').replace(/_/g, ' ');
  const hint = input.to || input.subject || input.title || input.url || input.file_path || '';
  return pretty + (hint ? ' — ' + String(hint).slice(0, 60) : '');
}

// ---------- main ----------
function renderMain() {
  const main = $('#main');
  if (!S.current) {
    const none = !S.data.bots.length;
    main.innerHTML = `<header class="head"><button class="icon-btn menu-btn" data-act="menu" aria-label="Menu">${ICON.menu}</button></header>
      <div class="thread"><div class="empty">
        <img class="logo-art" src="/nimbus.webp" alt="Nimbus" width="160" height="160">
        <h2>${none ? 'Build your team' : 'Pick a bot to talk to'}</h2>
        <p>${none ? 'Bots are teammates you hand work to. They run on your computer with Claude Code and ask before anything risky.' : 'Hand off a task. You’ll see each step, and it’ll check with you before sending, paying, deleting or merging.'}</p>
        ${none ? `<div class="row"><button class="btn primary" data-act="market">${ICON.grid} Browse Marketplace</button><button class="btn" data-act="new-bot">${ICON.plus} New bot</button></div>` : ''}
      </div></div>`;
    return;
  }
  const isBot = S.current.type === 'bot';
  const b = isBot ? bot(S.current.id) : null;
  const r = !isBot ? room(S.current.id) : null;
  if (!b && !r) { S.current = null; return renderMain(); }
  const nRoutines = isBot ? S.data.routines.filter((x) => x.bot_id === b.id).length : 0;
  const pending = S.data.approvals.length;
  main.innerHTML = `
    <header class="head">
      <button class="icon-btn menu-btn" data-act="menu" aria-label="Menu">${ICON.menu}</button>
      <button class="title" data-act="${isBot ? 'edit-bot' : 'edit-room'}">
        ${isBot ? avatar(b, 24) : roomAvatar(r, 24)}
        <b>${esc(isBot ? b.name : r.name)}</b>
        ${isBot && b.status.state !== 'idle' ? `<span class="status ${b.status.state}">${esc(b.status.label)}</span>` : ''}
      </button>
      <div class="actions">
        ${isBot ? `
          <label class="effort" title="Effort: higher is smarter but uses more of your plan">
            <button class="effort-btn" data-act="effort-menu" aria-label="Effort" aria-haspopup="menu">${esc(EFFORTS.find(([v]) => v === b.effort)?.[1] || 'Medium')}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></button>
          </label>
          <button class="icon-btn" data-act="routines" title="Routines" aria-label="Routines">${ICON.clock}${nRoutines ? `<i class="count">${nRoutines}</i>` : ''}</button>
          ${b.computer && S.data.computers ? `<button class="icon-btn" data-act="computer" title="${esc(b.name)}’s computer" aria-label="Computer">${ICON.monitor}</button>` : ''}
          <button class="icon-btn" data-act="plugins" title="Plugins" aria-label="Plugins">${ICON.plug}${b.plugins.length ? `<i class="count">${b.plugins.length}</i>` : ''}</button>
          <button class="icon-btn" data-act="memory" title="Memory" aria-label="Memory">${ICON.book}</button>
          <button class="icon-btn" data-act="reset" title="New chat (memory is kept)" aria-label="New chat">${ICON.compose}</button>
          <button class="icon-btn" data-act="info" title="Chat details: environment, context, connectors" aria-label="Chat details">${ICON.sidebar}</button>
          <button class="icon-btn" data-act="edit-bot" title="Settings" aria-label="Settings">${ICON.gear}</button>`
        : `<button class="icon-btn" data-act="edit-room" title="Settings" aria-label="Settings">${ICON.gear}</button>`}
        <button class="icon-btn" data-act="panel" title="Activity" aria-label="Activity">${ICON.bell}${pending ? `<i class="count hot">${pending}</i>` : ''}</button>
      </div>
    </header>
    <div class="thread" id="thread"><div class="thread-inner">${renderMessages()}</div></div>
    <div class="composer">
      <div class="attach-list" id="attach-list"></div>
      <form id="composer">
        <button type="button" class="plus" data-act="${isBot ? 'plugins' : 'edit-room'}" aria-label="${isBot ? 'Plugins' : 'Chat settings'}">${ICON.plus}</button>
        <button type="button" class="plus" data-act="attach" aria-label="Attach files">${ICON.clip}</button>
        <button type="button" class="plus mic" data-act="dictate" aria-label="Dictate" title="Dictate (tap to start, tap to stop)">${ICON.mic}</button>
        <input type="file" id="file-pick" multiple hidden>
        <label for="msg" class="sr">Message</label>
        <textarea id="msg" rows="1" placeholder="${isBot ? `Message ${esc(b.name)}` : `Message ${esc(r.name)} · @ a bot to direct it`}"></textarea>
        <button class="send" aria-label="Send">${ICON.send}</button>
      </form>
    </div>`;
  attachAutocorrect($('#msg'));
  if (isRecording() || browserStop) micState('recording'); // re-render during dictation
  const th = $('#thread');
  th.scrollTop = th.scrollHeight;
  const ta = $('#msg');
  const draft = sessionDraft.get(threadKey());
  if (draft) ta.value = draft;
  autosize(ta);
  if (matchMedia('(min-width: 761px)').matches) ta.focus();
}
const sessionDraft = new Map();
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; }

function renderMessages() {
  if (S.loadingThread) return '<div class="empty small">Loading…</div>';
  if (!S.messages.length) {
    const isBot = S.current.type === 'bot';
    const b = isBot ? bot(S.current.id) : null;
    return `<div class="empty">${isBot ? avatar(b, 72) : roomAvatar(room(S.current.id), 72)}<h2>${esc(isBot ? b.name : room(S.current.id).name)}</h2><p>${isBot ? esc(b.role || 'Give this bot a task. It’ll ask before sending, paying, deleting or merging.') : 'Post a goal. The lead bot splits the work, and bots @mention each other to hand things off.'}</p></div>`;
  }
  return S.messages.map((m, i) => renderMessage(m, S.messages[i - 1])).join('');
}

// Show the bot's name above its bubble in group chats, when the speaker changes.
function speakerLabel(m, prev) {
  if (S.current?.type !== 'room' || m.author === 'user') return '';
  if (prev && prev.author === m.author && prev.kind !== 'note') return '';
  const b = bot(m.author);
  return `<div class="speaker">${avatar(b, 18)}<span style="color:${esc(b?.color || '#999')}">${esc(b?.name || 'Deleted bot')}</span></div>`;
}
const fileUrl = (f) => `/api/files/${f.id}/${encodeURIComponent(f.name)}`;
const isImage = (f) => /^image\/(png|jpe?g|gif|webp|avif)$/.test(f.type);
function renderFiles(m) {
  let files = [];
  try { files = JSON.parse(m.files || '[]'); } catch {}
  if (!files.length) return '';
  return `<div class="files">${files.map((f) => isImage(f)
    ? `<a class="file-img" href="${fileUrl(f)}" target="_blank" rel="noopener"><img src="${fileUrl(f)}" alt="${esc(f.name)}" loading="lazy"></a>`
    : f.preview ? `<div class="file-card"><a href="${fileUrl(f.preview)}" target="_blank" rel="noopener"><img src="${fileUrl(f.preview)}" alt="Preview of ${esc(f.name)}" loading="lazy"></a>
        <div class="fc-row">${ICON.clip}<span>${esc(f.name)}</span><small>${fmtSize(f.size)}</small><a class="btn pill small" href="${fileUrl(f)}" download>Download</a></div></div>`
        : `<a class="file-chip" href="${fileUrl(f)}" target="_blank" rel="noopener">${ICON.clip}<span>${esc(f.name)}</span><small>${fmtSize(f.size)}</small></a>`).join('')}</div>`;
}
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

// ---------- right-click (or long-press) a message: redact ----------
document.addEventListener('contextmenu', (e) => {
  const msg = e.target.closest('#thread .msg[data-mid], #thread .note[data-mid]');
  if (!msg || drag) return;
  const bubble = msg.querySelector('.bubble, .approval, .trace') || msg;
  const sel = String(getSelection() || '').trim();
  const inside = sel && getSelection().anchorNode && bubble.contains(getSelection().anchorNode);
  e.preventDefault();
  closePopover();
  const id = Number(msg.dataset.mid);
  const el = document.createElement('div');
  el.className = 'popover';
  el.innerHTML = `${inside ? `<button data-redact-sel>${ICON.lock}<span>Redact “${esc(sel.length > 24 ? sel.slice(0, 24) + '…' : sel)}”</span></button>` : ''}
    <button data-redact-all>${ICON.lock}<span>Redact whole message</span></button>
    <button data-copy-msg>${ICON.check}<span>Copy</span></button>`;
  document.body.append(el);
  el.style.left = Math.max(8, Math.min(e.clientX, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(e.clientY, innerHeight - el.offsetHeight - 8)) + 'px';
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    closePopover();
    const m = S.messages.find((x) => x.id === id);
    if (b.dataset.copyMsg !== undefined) { await navigator.clipboard?.writeText(m?.body || '').catch(() => {}); return toast('Copied'); }
    const text = b.dataset.redactSel !== undefined ? sel : '';
    if (!confirm(text ? `Replace “${text.slice(0, 80)}” with [REDACTED] everywhere Nimbus stored it?` : 'Replace this whole message with [REDACTED]? It’s also removed from saved prompts and bot transcripts.')) return;
    try {
      const r = await api(`/api/messages/${id}/redact`, { method: 'POST', body: { text } });
      buzz(10); toast(`Redacted${r.transcripts ? ` (also in ${r.transcripts} transcript${r.transcripts > 1 ? 's' : ''})` : ''}`);
    } catch (err) { toast(err.message); }
  });
});

// ---------- slash commands in the message box ----------
const SLASH = [['/context', 'Open chat details: what’s using this chat’s context'], ['/compact', 'Shrink this chat’s history so it uses less context (memory is kept)'], ['/new', 'Start a fresh chat with this bot (memory is kept)']];
function slashHint(v) {
  let box = $('#slash-hint');
  const show = S.current?.type === 'bot' && /^\/\w*$/.test(v);
  const items = show ? SLASH.filter(([c]) => c.startsWith(v.toLowerCase())) : [];
  if (!items.length) return box?.remove();
  if (!box) { box = document.createElement('div'); box.id = 'slash-hint'; box.className = 'slash-hint'; $('.composer').prepend(box); }
  box.innerHTML = items.map(([c, d]) => `<button type="button" data-slash="${c}"><b>${c}</b><span>${d}</span></button>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slash]'); if (!b) return;
  const ta = $('#msg'); ta.value = b.dataset.slash; $('#slash-hint')?.remove(); $('#composer').requestSubmit();
});

// ---------- read aloud ----------
// Plays a bot reply spoken by Piper on the server. Tapping again (or another reply) stops it.
let speaking = null; // { audio, btn }
async function speak(btn) {
  const same = speaking?.btn === btn;
  if (speaking) { speaking.audio.pause(); speaking.btn.textContent = '▶ Read aloud'; speaking = null; }
  if (same) return;
  btn.textContent = '… Loading';
  try {
    const r = await fetch('/api/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: Number(btn.dataset.speak) }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Couldn’t read that aloud');
    const audio = new Audio(URL.createObjectURL(await r.blob()));
    speaking = { audio, btn };
    btn.textContent = '■ Stop';
    audio.onended = () => { if (speaking?.audio === audio) { btn.textContent = '▶ Read aloud'; speaking = null; } };
    await audio.play();
  } catch (err) { btn.textContent = '▶ Read aloud'; toast(err.message); }
}
function flashMessage(id) {
  const el = document.querySelector(`[data-mid="${id}"]`);
  if (!el) return toast('That message is further back in the chat');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2200);
}

// ---------- share from other apps (Android app) ----------
// The app calls this with { text, files: [{ name, type, data (base64) }] }; you pick which bot gets it.
window.nimbusShare = (share) => {
  if (!S.data) { setTimeout(() => window.nimbusShare(share), 500); return; }
  const files = (share.files || []).map((f) => {
    const bin = atob(f.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || 'shared-file', { type: f.type || '' });
  });
  const what = [share.text ? 'text' : '', files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  const el = modal(`<div class="modal-head"><h2>Share ${esc(what)} with…</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div class="stack-list">${S.data.bots.map((b) => `<button class="card-item" data-share-to="bot:${b.id}">${avatar(b, 30)}<span><b>${esc(b.name)}</b><small>${esc(b.role || '')}</small></span></button>`).join('')}</div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    const t = e.target.closest('[data-share-to]'); if (!t) return;
    closeModal();
    await openThread(t.dataset.shareTo);
    const ta = $('#msg');
    if (share.text && ta) { ta.value = share.text.trim(); autosize(ta); }
    if (files.length) addFiles(files);
    ta?.focus();
  });
};

// ---------- dictation ----------
// Tap the mic to start, tap again to stop; the text lands at the cursor for you to edit before sending.
let browserStop = null;
function insertAtCursor(text) {
  const ta = $('#msg'); if (!ta || !text) return;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  const before = ta.value.slice(0, a), after = ta.value.slice(b);
  const piece = (before && !/\s$/.test(before) ? ' ' : '') + text.trim() + (after && !/^\s/.test(after) ? ' ' : '');
  ta.value = before + piece + after;
  const pos = before.length + piece.length;
  ta.focus(); ta.setSelectionRange(pos, pos); autosize(ta);
}
function micState(state) {
  const btn = $('.composer .mic'); if (!btn) return;
  btn.classList.toggle('recording', state === 'recording');
  btn.classList.toggle('busy', state === 'busy');
  btn.setAttribute('aria-label', state === 'recording' ? 'Stop dictation' : 'Dictate');
  if (state !== 'recording') btn.style.removeProperty('--level');
}
async function finishDictation() {
  micState('busy');
  try { insertAtCursor(await stopRecording(api)); }
  catch (err) {
    toast(err.message);
  } finally { micState('idle'); }
}
async function toggleDictation(btn) {
  buzz(10);
  if (browserStop) { browserStop(); browserStop = null; return micState('idle'); }
  if (isRecording()) return finishDictation();
  if (btn.classList.contains('busy')) return;
  if (S.whisper === undefined) S.whisper = (await api('/api/transcribe').catch(() => ({}))).available;
  if (!S.whisper) {
    // Server dictation is off: use the browser's own recognition if it has one.
    browserStop = browserDictation(insertAtCursor, () => { browserStop = null; micState('idle'); });
    if (browserStop) { micState('recording'); return toast('Using your browser’s dictation (server dictation is off)'); }
    return toast('Dictation isn’t available right now');
  }
  try {
    await startRecording({
      onLevel: (p) => btn.style.setProperty('--level', Math.min(1, p * 3).toFixed(2)),
      onLimit: () => { toast('Stopped at 5 minutes'); finishDictation(); }
    });
    micState('recording');
  } catch (err) {
    cancelRecording();
    toast(err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser’s site settings.' : err.message);
  }
}

// ---------- attachments ----------
// Files upload as soon as they're picked, pasted or dropped; Send includes the finished ones.
let attachments = []; // { key, name, type, size, id?, error?, preview? }
function drawAttachments() {
  const el = $('#attach-list'); if (!el) return;
  el.innerHTML = attachments.map((a) => `<span class="attach ${a.id ? '' : a.error ? 'bad' : 'busy'}" title="${esc(a.error || a.name)}">
    ${a.preview ? `<img src="${a.preview}" alt="">` : ICON.clip}<span>${esc(a.name)}</span><small>${a.error ? 'Failed' : a.id ? fmtSize(a.size) : 'Uploading…'}</small>
    <button type="button" data-unattach="${a.key}" aria-label="Remove ${esc(a.name)}">${ICON.close}</button></span>`).join('');
}
function addFiles(list) {
  for (const file of list) {
    if (attachments.length >= 10) { toast('Up to 10 files per message'); break; }
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB`); continue; }
    const a = { key: Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', type: file.type, size: file.size,
      preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
    attachments.push(a);
    const reader = new FileReader();
    reader.onload = async () => {
      try { Object.assign(a, await api('/api/uploads', { method: 'POST', body: { name: a.name, type: a.type, data: String(reader.result).split(',')[1] || '' } })); }
      catch (err) { a.error = err.message; }
      drawAttachments();
    };
    reader.readAsDataURL(file);
  }
  drawAttachments();
}
function clearAttachments() {
  for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
  attachments = []; drawAttachments();
}

function renderMessage(m, prev) {
  if (m.author === 'user') return `<div class="msg user" data-mid="${m.id}">${renderFiles(m)}${m.body ? `<div class="bubble">${esc(m.body)}</div>` : ''}
    ${m.body ? `<div class="msg-actions"><button data-copy="${m.id}" title="Copy">Copy</button><button data-edit="${m.id}" title="Edit and resend">Edit</button><button data-retry="${m.id}" title="Send again">Retry</button></div>` : ''}</div>`;
  if (m.kind === 'note') return `<div class="note" data-mid="${m.id}">${esc(m.body)}</div>`;
  if (m.kind === 'quiet') return `<div class="note quiet-ok" data-mid="${m.id}" title="Quiet check at ${clock(m.created_at)}">✓ All clear · ${esc(m.body)} <span class="muted">· ${clock(m.created_at)}</span></div>`;
  const b = bot(m.author) || { name: 'Deleted bot', color: '#555' };
  if (m.kind === 'trace') return renderTrace(m, prev);
  if (m.kind === 'approval') return renderApproval(m, b, prev);
  if (m.kind === 'doc') { let d = {}; try { d = JSON.parse(m.body); } catch {} return `<div class="msg bot" data-mid="${m.id}">${speakerLabel(m, prev)}<button class="doc-card" data-doc-open="${esc(d.docId || '')}"><span class="dc-ico">📄</span><span><b>${esc(d.title || 'Document')}</b><small>Live document · click to open</small></span><span class="dc-open">Open</span></button></div>`; }
  return `<div class="msg bot ${m.kind === 'error' ? 'error' : ''}" data-mid="${m.id}" title="${clock(m.created_at)}">${speakerLabel(m, prev)}<div class="bubble md">${md(m.body)}</div>
    <div class="msg-actions"><button data-copy="${m.id}">Copy</button>${m.kind === 'error' ? '<button data-continue="1">Try again</button>' : `<button data-speak="${m.id}">▶ Read aloud</button><button data-continue="1">Continue</button>`}</div></div>`;
}

// While a bot works, the label cycles through cloud-themed phrases. The phrase is picked from the
// elapsed time, so re-renders never make it jump, and every live trace stays in step.
const WORK_PHRASES = ['Thinking', 'Gathering clouds', 'Connecting the dots', 'Drifting through ideas', 'Brewing a plan',
  'Reading the sky', 'Condensing thoughts', 'Tinkering', 'Chasing a hunch', 'Weaving it together', 'Polishing', 'Almost there, probably'];
const PHRASE_MS = 3500;
// Clamped at 0: the server's clock can be ahead of this device's, which made the index negative ("undefined").
const elapsedMs = (started) => Math.max(0, Date.now() - (Number(started) || Date.now()));
const workPhrase = (started) => WORK_PHRASES[Math.floor(elapsedMs(started) / PHRASE_MS) % WORK_PHRASES.length];
const fmtDur = (secs) => (secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`);
const LOADER = '<span class="loader" aria-hidden="true"><i></i><i></i><i></i></span>';

// Run stats instead of a dollar figure: tokens used, how full the context is, and plan usage left.
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
function traceStats(t) {
  const bits = [];
  if (t.tokens) bits.push(`<span title="Tokens read / written this run (including cached context)">${fmtTok(t.tokens.in)} in · ${fmtTok(t.tokens.out)} out</span>`);
  if (t.context) {
    const win = t.contextWindow || 200000, pc = Math.min(100, Math.round((t.context / win) * 100));
    bits.push(`<button class="ctx ${pc >= 80 ? 'hot' : pc >= 60 ? 'warm' : ''}" data-ctx="1" title="Context in use: ${t.context.toLocaleString()} of ${win.toLocaleString()} tokens. Click for details.">ctx ${pc}%</button>`);
  }
  const five = planLast?.ok && planLast.windows.find((w) => w.label === '5-hour limit');
  if (five && t.status !== 'running') bits.push(`<span title="Claude plan: 5-hour limit left right now">${Math.max(0, Math.round(100 - five.used))}% left</span>`);
  return bits.length ? ' · ' + bits.join(' · ') : '';
}

function renderTrace(m, prev) {
  const t = JSON.parse(m.body);
  const running = t.status === 'running';
  if (t.status === 'done' && !t.steps.length) return `<div data-mid="${m.id}" hidden></div>`;
  const secs = Math.round((t.ended ? Math.max(0, t.ended - t.started) : elapsedMs(t.started)) / 1000);
  const dur = fmtDur(secs);
  const mark = { done: '✓', waiting: '⏸', error: '✗', rejected: '✗', stopped: '■', running: '' };
  const waiting = running && t.steps.some((s) => s.state === 'waiting');
  const label = running ? (waiting ? 'Waiting for your approval' : t.source === 'auto-compact' || t.compacting ? '<span class="shimmer">Compacting the chat…</span>' : `<span class="shimmer" data-phrase>${workPhrase(t.started)}</span>`) :
    t.status === 'done' ? `${t.steps.length} step${t.steps.length === 1 ? '' : 's'}` : t.status === 'stopped' ? 'Stopped' : t.status === 'interrupted' ? 'Interrupted' : 'Run failed';
  const open = running || openTraces.has(m.id);
  return `<div class="msg bot" data-mid="${m.id}">${speakerLabel(m, prev)}<details class="trace ${running ? 'live' : ''} ${waiting ? 'paused' : ''}" ${open ? 'open' : ''} data-started="${t.started}">
    <summary>${running ? LOADER : ICON.chevron}<span>${label}</span><span class="sp"><span data-dur>${dur}</span>${traceStats(t)}</span>${running ? `<button class="stop" data-stop="${m.run_id}">Stop</button>` : ''}</summary>
    <div class="steps">
      ${t.steps.map((s) => `<div class="step"><span class="mark ${s.state}">${mark[s.state] ?? ''}</span><span>${esc(s.text)}</span></div>`).join('')}
      ${running && t.lastThought ? `<div class="thought">${esc(t.lastThought)}</div>` : ''}
    </div>
  </details></div>`;
}
const openTraces = new Set();

function renderApproval(m, b, prev) {
  const a = JSON.parse(m.body);
  const pending = a.status === 'pending';
  const input = a.tool === 'Bash' ? a.input.command : JSON.stringify(a.input, null, 2);
  const done = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired' }[a.status];
  return `<div class="msg bot" data-mid="${m.id}">${speakerLabel(m, prev)}<div class="approval ${pending ? '' : 'decided'}">
    <div class="label">${ICON.lock} ${pending ? 'Needs your approval' : done}</div>
    <div>${esc(describeTool(a.tool, a.input).split(' — ')[0].replace(/^Run: .*/, 'Run a command'))}</div>
    <pre>${esc(input)}</pre>
    ${a.note ? `<div class="muted">Your note: ${esc(a.note)}</div>` : ''}
    ${pending ? `<div class="row">
      <button class="btn primary" data-approve="${a.approvalId}">Approve</button>
      <button class="btn" data-reject="${a.approvalId}">Reject…</button>
      <label>Then <select data-remember="${a.approvalId}">
        <option value="">ask again next time</option>
        <option value="exact">always allow ${a.tool === 'Bash' ? 'this exact command' : 'this tool'}</option>
        ${a.pattern ? `<option value="pattern">always allow “${esc(a.pattern)}”</option>` : ''}
      </select></label>
    </div>` : ''}
  </div></div>`;
}

// ---------- navigation ----------
async function openThread(key) {
  const [type, id] = key.split(':');
  const prev = threadKey();
  if (prev) sessionDraft.set(prev, $('#msg')?.value || '');
  S.current = { type, id: Number(id) };
  history.replaceState(null, '', '#' + key);
  if (infoBot) { if (type === 'bot') { if (infoBot !== Number(id)) { $('#info').innerHTML = ''; openInfo({ id: Number(id) }); } } else closeInfo(); }
  S.loadingThread = true; S.messages = [];
  $('#side').classList.remove('open'); $('#aside').classList.remove('open');
  renderSide(); renderMain();
  S.messages = await api(`/api/threads/${encodeURIComponent(key)}/messages`);
  S.loadingThread = false;
  if (threadKey() === key) { renderMain(); $('.thread-inner')?.classList.add('fade-in'); }
}

let stateSeq = 0;
async function refreshState() {
  // Overlapping refreshes can finish out of order; only the newest one wins.
  const seq = ++stateSeq;
  const data = await api('/api/state');
  if (seq !== stateSeq) return;
  S.data = data;
  const focused = document.activeElement?.id === 'side-search';
  renderSide(); renderAside();
  if (focused) { const i = $('#side-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

// ---------- live updates ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.thread === threadKey() && !S.messages.some((x) => x.id === m.id)) {
      const prev = S.messages[S.messages.length - 1];
      S.messages.push(m);
      const th = $('#thread');
      if (!th) return;
      const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 200;
      const inner = $('.thread-inner', th);
      if (S.messages.length === 1) inner.innerHTML = '';
      inner.insertAdjacentHTML('beforeend', renderMessage(m, prev));
      inner.lastElementChild?.classList.add('enter');
      if (m.author !== 'user' && m.kind === 'text') buzz(6);
      if (nearBottom || m.author === 'user') th.scrollTop = th.scrollHeight;
    }
    if (m.kind === 'approval' && m.author !== 'user') notify(m);
    soon();
  });
  es.addEventListener('message_update', (e) => {
    const m = JSON.parse(e.data);
    const i = S.messages.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    S.messages[i] = m;
    if (m.kind === 'trace' && infoBot && m.thread === 'bot:' + infoBot && JSON.parse(m.body || '{}').status !== 'running') setTimeout(loadInfo, 800);
    const el = document.querySelector(`[data-mid="${m.id}"]`);
    if (el) {
      const th = $('#thread');
      const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 200;
      el.outerHTML = renderMessage(m, S.messages[i - 1]);
      if (nearBottom) th.scrollTop = th.scrollHeight;
    }
  });
  let pending;
  const soon = () => { clearTimeout(pending); pending = setTimeout(async () => { await refreshState(); if (S.current) updateHeaderBits(); }, 150); };
  for (const ev of ['bot_status', 'state_changed', 'approvals_changed']) es.addEventListener(ev, soon);
  es.addEventListener('doc_changed', (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== DOC.id) return;
    if (m.deleted) return closeDoc();
    if (m.actor === 'you' && !m.comments) return; // our own edit: already reloaded
    reloadDoc(m.blocks || []);
  });
  es.onerror = () => { fetch('/api/state').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {}); };
  es.onopen = () => { refreshState(); if (S.current) openThread(threadKey()); };
}
function updateHeaderBits() {
  const b = S.current?.type === 'bot' ? bot(S.current.id) : null;
  const st = $('.head .status');
  if (b) {
    const html = b.status.state !== 'idle' ? `<span class="status ${b.status.state}">${esc(b.status.label)}</span>` : '';
    if (st) st.outerHTML = html; else if (html) $('.head .title')?.insertAdjacentHTML('beforeend', html);
  }
  const bell = $('.head [data-act="panel"]');
  if (bell) bell.innerHTML = ICON.bell + (S.data.approvals.length ? `<i class="count hot">${S.data.approvals.length}</i>` : '');
}
setInterval(() => { // tick live timers and rotate phrases in place, so animations don't restart
  document.querySelectorAll('details.trace.live').forEach((el) => {
    const started = Number(el.dataset.started);
    const dur = $('[data-dur]', el);
    if (dur) dur.textContent = fmtDur(Math.round(elapsedMs(started) / 1000));
    const ph = $('[data-phrase]', el), next = workPhrase(started);
    if (ph && ph.textContent !== next) {
      ph.classList.add('out');
      setTimeout(() => { ph.textContent = next; ph.classList.remove('out'); }, 250);
    }
  });
}, 1000);

function notify(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const a = JSON.parse(m.body);
  const n = new Notification(`${bot(m.author)?.name || 'A bot'} needs approval`, { body: describeTool(a.tool, a.input), icon: '/icon.svg', tag: 'approval-' + a.approvalId });
  n.onclick = () => { window.focus(); openThread(m.thread); };
}

// ---------- popover menus ----------
function popover(anchor, items) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'popover';
  el.innerHTML = items.map(([act, label, icon]) => `<button data-act="${act}">${icon || ''}<span>${label}</span></button>`).join('');
  document.body.append(el);
  const below = r.bottom + el.offsetHeight + 8 < innerHeight;
  el.style.top = (below ? r.bottom + 6 : r.top - el.offsetHeight - 6) + 'px';
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
}
function closePopover() { document.querySelector('.popover')?.remove(); }

// ---------- modals ----------
function modal(html, { wide = false, cls = '', sticky = false } = {}) {
  closePopover();
  const root = $('#modal-root');
  root.innerHTML = `<div class="scrim"><div class="modal ${wide ? 'wide' : ''} ${sticky ? 'sticky' : ''} ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const scrim = $('.scrim', root);
  if (!sticky) scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  setTimeout(() => $('input:not([type=checkbox]):not([type=color]), textarea', root)?.focus(), 30);
  return $('.modal', root);
}
// Plays the close animation, unless another modal replaced this one meanwhile.
function closeModal() {
  const root = $('#modal-root'), scrim = $('.scrim', root);
  if (!scrim || scrim.classList.contains('closing')) return;
  scrim.classList.add('closing');
  setTimeout(() => { if (root.contains(scrim)) root.innerHTML = ''; }, 160);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('.modal.sticky')) closeModal(); closePopover(); } });

// Where this chat's context goes, from Claude Code's own /context report.
const CTX_COLORS = { 'System prompt': '#9ca3af', 'System tools': '#6366f1', 'System tools (deferred)': '#6b7280', 'MCP tools': '#10b981', 'MCP tools (deferred)': '#6b7280',
  'Memory files': '#a78bfa', 'Skills': '#f59e0b', 'Custom agents': '#ec4899', 'Messages': '#f97316', 'Autocompact buffer': '#4b5563', 'Free space': 'transparent' };
// Chat details: a side panel like Claude's — where the bot runs, what's using its context, its connectors.
let infoBot = null, infoBusy = false;
function openInfo(b) {
  infoBot = b.id;
  $('#aside').classList.remove('open');
  const el = $('#info');
  el.classList.add('open');
  loadInfo();
}
function closeInfo() { infoBot = null; $('#info').classList.remove('open'); }
async function loadInfo() {
  const b = bot(infoBot), el = $('#info');
  if (!b || infoBusy) return;
  infoBusy = true;
  const keep = el.querySelector('.info-body') ? [...el.querySelectorAll('details[open]')].map((d) => d.dataset.k) : ['env', 'ctx', 'conn'];
  if (!el.querySelector('.info-body')) el.innerHTML = `<div class="aside-head"><b>${esc(b.name)}</b><button class="icon-btn" data-info-close aria-label="Close">${ICON.close}</button></div><div class="info-body"><div class="muted">${LOADER} Loading…</div></div>`;
  let r;
  try { r = await api(`/api/bots/${b.id}/context`); }
  catch (e) { r = { error: e.message }; }
  infoBusy = false;
  if (infoBot !== b.id) return;
  const sec = (k, title, body) => `<details class="info-sec" data-k="${k}" ${keep.includes(k) ? 'open' : ''}><summary>${title}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></summary>${body}</details>`;
  const env = r.env ? `
    <div class="info-line">${ICON.monitor}<span>${esc(r.env.where)}</span></div>
    <div class="info-line" title="${esc(r.env.folder)}">${ICON.box}<span>${esc(r.env.folder.split(/[\\/]/).slice(-3).join('/'))}</span></div>
    <div class="info-line">${ICON.gear}<span>${esc(r.context?.model || r.env.model || 'Default model')} · ${esc(EFFORTS.find(([v]) => v === r.env.effort)?.[1] || r.env.effort)} effort</span></div>` : '';
  const conn = r.env ? [
    ...(r.plugins || []).map((p) => `<div class="info-line"><span class="pi" style="background:${esc(p.color || '#666')}">${esc(p.icon || p.name[0])}</span><span>${esc(p.name)}</span><em>plugin</em></div>`),
    ...(r.connectors || []).map((c) => `<div class="info-line"><span class="pi" style="background:${esc(c.color || '#666')}">${esc(c.icon || c.name[0])}</span><span>${esc(c.name)}</span><em class="${c.status === 'connected' ? '' : 'bad'}">${c.status === 'connected' ? '' : esc(c.status)}</em></div>`)
  ].join('') || '<div class="muted">No connectors. Add some from Plugins.</div>' : '';
  el.querySelector('.info-body').innerHTML =
    (r.env ? sec('env', 'Environment', env) : '') +
    sec('ctx', 'Context', r.context ? contextHtml(r.context) : `<div class="muted">${esc(r.error || 'Not available')}</div>`) +
    (r.env ? sec('conn', 'Connectors', conn + `<button class="btn pill small" data-act="plugins">Manage plugins</button>`) : '');
}
function contextHtml(r) {
  const deferred = (c) => /deferred/i.test(c.name);
  const live = r.categories.filter((c) => !deferred(c)), later = r.categories.filter(deferred);
  const pctUsed = r.total ? Math.round((r.used / r.total) * 100) : 0;
  const color = (n) => CTX_COLORS[n] || '#9ca3af';
  const pc = (c) => (c.pct < 0.1 && c.tokens ? '<0.1' : c.pct.toFixed(1)) + '%';
  const row = (c, dim) => `<div class="ctx-row ${dim ? 'dim' : ''}"><i style="background:${color(c.name)}"></i><span>${esc(c.name)}</span><b>${fmtTok(c.tokens)}</b><em>${dim ? '—' : pc(c)}</em></div>`;
  return `<div class="ctxp">
    <div class="ctx-top"><b>${pctUsed}% used</b><span>${fmtTok(r.used)} / ${fmtTok(r.total)}</span></div>
    <div class="ctx-bar">${live.filter((c) => c.name !== 'Free space').map((c) => `<i style="width:${Math.max(c.pct, c.tokens ? 0.4 : 0)}%;background:${color(c.name)}" title="${esc(c.name)}: ${fmtTok(c.tokens)}"></i>`).join('')}</div>
    <div class="ctx-rows">${live.map((c) => row(c)).join('')}</div>
    ${later.length ? `<div class="ctx-rows later" title="Loaded only when the bot asks for them">${later.map((c) => row(c, true)).join('')}</div>` : ''}
    ${r.sections.map((s) => `<details class="ctx-sec"><summary>${ICON.chevron}<span>${esc(s.title)}</span><em>${s.rows.length}</em></summary>
      ${s.rows.map((x) => `<div class="ctx-item"><span title="${esc(x.detail)}">${esc(x.name)}${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</span><b>${x.tokens ? fmtTok(x.tokens) : ''}</b></div>`).join('')}</details>`).join('')}
    <div class="ctx-foot"><button class="btn pill small" data-info-refresh>Refresh</button><button class="btn pill small" data-ctx-compact>Compact now</button></div></div>`;
}
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#info')) return;
  if (e.target.closest('[data-info-close]')) return closeInfo();
  if (e.target.closest('[data-info-refresh]')) return loadInfo();
  if (e.target.closest('[data-ctx-compact]') && infoBot) await api(`/api/threads/${encodeURIComponent('bot:' + infoBot)}/messages`, { method: 'POST', body: { text: '/compact' } });
});

function botModal(b) {
  const isNew = !b;
  b = b || { name: '', role: '', instructions: '', color: BOT_COLORS[S.data.bots.length % BOT_COLORS.length], shape: 'none/none', effort: 'medium', model: '',
    approval_rules: ['Bash(git push*)', 'Bash(rm -rf*)', 'Bash(*gh pr merge*)', 'mcp__*send*', 'mcp__*delete*', 'mcp__*pay*', 'mcp__*create_event*'], allow_rules: [] };
  let color = b.color;
  const look = outfit(b);
  const el = modal(`
    <div class="modal-head"><h2>${isNew ? 'New bot' : 'Bot settings'}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div class="bot-look"><div id="f-preview"></div>
      <div class="look-pick">
        <div class="swatches">${BOT_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-pressed="${c === color}" aria-label="Color ${c}"></button>`).join('')}
          <label class="swatch custom" title="Pick any color" aria-pressed="${!BOT_COLORS.includes(color)}" style="${BOT_COLORS.includes(color) ? '' : `background:${esc(color)}`}"><input type="color" id="f-color" value="${esc(/^#[0-9a-f]{6}$/i.test(color) ? color : '#c9c2f0')}" aria-label="Custom color"></label>
          <button type="button" class="btn small" data-random title="Random look">🎲 Surprise me</button></div>
        <div class="look-tabs" role="tablist">${LOOK_PARTS.map(([k, , label], i) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${i === 0}">${label}</button>`).join('')}</div>
        <div class="shapes" id="f-picks"></div>
      </div></div>
    <label class="field">Name<input id="f-name" value="${esc(b.name)}" placeholder="e.g. Inbox Manager"></label>
    <label class="field">Role (one line)<input id="f-role" value="${esc(b.role)}" placeholder="Gets my inbox to zero and drafts replies"></label>
    <label class="field">Instructions<textarea id="f-instr" rows="6" placeholder="What this bot is for, how it should work, what tools or folders to use…">${esc(b.instructions)}</textarea></label>
    <div class="two">
      <label class="field">Effort<select id="f-effort">${EFFORTS.map(([v, l]) => `<option value="${v}" ${b.effort === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="hint">Lower effort uses less of your plan.</span></label>
      <label class="field">Model<input id="f-model" value="${esc(b.model)}" placeholder="Default"><span class="hint">Optional, e.g. sonnet or opus.</span></label>
    </div>
    <label class="toggle-row"><span class="p-icon" style="width:34px;height:34px;background:#2a3a6b">${ICON.monitor}</span>
      <span class="m-text"><b>Own computer</b><span>${S.data.computers ? 'Works on its own desktop on your computer VM, with its own browser and sign-ins.' : 'Set up the computer VM first in Server settings (see deploy/computer/README.md).'}</span></span>
      <input type="checkbox" class="switch" id="f-computer" ${b.computer ? 'checked' : ''} ${S.data.computers ? '' : 'disabled'}></label>
    <details class="adv"><summary>Approval rules</summary>
      <label class="field">Ask me before (one rule per line)<textarea id="f-rules" class="code" rows="5">${esc(b.approval_rules.join('\n'))}</textarea>
        <span class="hint">Tool names with * wildcards. Bash(pattern) matches commands, e.g. Bash(git push*). Plugin tools start with mcp__.</span></label>
      <label class="field">Always allow (overrides the list above)<textarea id="f-allow" class="code" rows="2">${esc(b.allow_rules.join('\n'))}</textarea>
        <span class="hint">Add <code>@self-email</code> to let this bot email only you without asking.</span></label>
    </details>
    <div class="modal-foot">
      ${isNew ? '' : '<button class="btn danger left" id="f-del">Delete bot</button>'}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="f-save">${isNew ? 'Create bot' : 'Save'}</button>
    </div>`, { wide: true });
  const preview = () => { $('#f-preview', el).innerHTML = avatar({ color, shape: lookShape(look) }, 84); };
  let tab = 'body';
  const setColor = (c) => {
    color = c;
    el.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.color === c));
    const cu = $('.swatch.custom', el); cu.setAttribute('aria-pressed', !BOT_COLORS.includes(c)); cu.style.background = BOT_COLORS.includes(c) ? '' : c;
    preview(); drawPicks();
  };
  // One row of choices for the selected tab; each shows the critter in the current color with that item.
  const drawPicks = () => {
    const [key, list] = LOOK_PARTS.find(([k]) => k === tab);
    $('#f-picks', el).innerHTML = list.map((v) => `<button type="button" class="shape" data-part="${key}" data-val="${v}" aria-pressed="${look[key] === v}" title="${v}" aria-label="${key}: ${v}">
      <svg viewBox="0 0 14 14" width="30" height="30" shape-rendering="crispEdges">${critter(color, { ...look, [key]: v })}</svg></button>`).join('');
  };
  preview();
  el.addEventListener('input', (e) => { if (e.target.id === 'f-color') setColor(e.target.value); });
  el.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) setColor(sw.dataset.color);
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; el.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === tb)); drawPicks(); }
    const pb = e.target.closest('[data-part]');
    if (pb) { look[pb.dataset.part] = pb.dataset.val; preview(); drawPicks(); }
    if (e.target.closest('[data-random]')) {
      const any = (l) => l[Math.floor(Math.random() * l.length)];
      // Accessories are optional, so "none" comes up often enough to keep random bots readable.
      for (const [k, list] of LOOK_PARTS) look[k] = ['hat', 'glasses', 'extra'].includes(k) && Math.random() < 0.35 ? list[0] : any(list);
      setColor(any(BOT_COLORS));
    }
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'f-del' && confirm(`Delete ${b.name}? Its chat history stays in the database, but the bot is gone.`)) {
      await api(`/api/bots/${b.id}`, { method: 'DELETE' }); closeModal(); S.current = null; history.replaceState(null, '', '#'); await refreshState(); renderMain();
    }
    if (e.target.id === 'f-save') {
      const lines = (id) => $(id, el).value.split('\n').map((s) => s.trim()).filter(Boolean);
      const payload = { name: $('#f-name', el).value.trim(), role: $('#f-role', el).value.trim(), instructions: $('#f-instr', el).value, color, shape: lookShape(look),
        effort: $('#f-effort', el).value, computer: $('#f-computer', el).checked, model: $('#f-model', el).value.trim(), approval_rules: lines('#f-rules'), allow_rules: lines('#f-allow') };
      if (!payload.name) return toast('Give the bot a name');
      try {
        const saved = isNew ? await api('/api/bots', { method: 'POST', body: payload }) : await api(`/api/bots/${b.id}`, { method: 'PATCH', body: payload });
        closeModal(); await refreshState(); openThread('bot:' + saved.id);
      } catch (err) { toast(err.message); }
    }
  });
  drawPicks();
}

function roomModal(r) {
  const isNew = !r;
  r = r || { name: '', goal: '', members: [], lead_bot_id: null, bots_can_talk: 1 };
  if (isNew && !S.data.bots.length) return toast('Add a bot first');
  const members = new Set(r.members);
  let lead = r.lead_bot_id;
  const el = modal(`
    <div class="modal-head"><h2>${isNew ? 'New group chat' : 'Group chat settings'}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <label class="field">Name<input id="r-name" value="${esc(r.name)}" placeholder="Offsite crew"></label>
    <label class="field">Goal (bots see this)<textarea id="r-goal" rows="2" placeholder="Plan the team offsite for March.">${esc(r.goal)}</textarea></label>
    <div class="field">Bots<div id="r-picks" class="picks"></div></div>
    <label class="check"><input type="checkbox" id="r-talk" ${r.bots_can_talk ? 'checked' : ''}> Bots can @mention each other to hand off work</label>
    <div class="modal-foot">
      ${isNew ? '' : '<button class="btn danger left" id="r-del">Delete chat</button>'}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="r-save">${isNew ? 'Create chat' : 'Save'}</button>
    </div>`);
  const drawPicks = () => {
    $('#r-picks', el).innerHTML = S.data.bots.map((b) => {
      const on = members.has(b.id);
      return `<label class="pick ${on ? 'on' : ''}">
        <input type="checkbox" data-member="${b.id}" ${on ? 'checked' : ''}>${avatar(b, 28)}<span>${esc(b.name)}</span>
        ${on ? `<span class="lead"><input type="radio" name="lead" data-lead="${b.id}" ${lead === b.id ? 'checked' : ''}> Lead</span>` : ''}
      </label>`;
    }).join('');
  };
  drawPicks();
  el.addEventListener('change', (e) => {
    if (e.target.dataset.member) {
      const id = Number(e.target.dataset.member);
      e.target.checked ? members.add(id) : members.delete(id);
      if (!members.has(lead)) lead = [...members][0] ?? null;
      drawPicks();
    }
    if (e.target.dataset.lead) lead = Number(e.target.dataset.lead);
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'r-del' && confirm(`Delete ${r.name}?`)) {
      await api(`/api/rooms/${r.id}`, { method: 'DELETE' }); closeModal(); S.current = null; await refreshState(); renderMain();
    }
    if (e.target.id === 'r-save') {
      const payload = { name: $('#r-name', el).value.trim(), goal: $('#r-goal', el).value.trim(), members: [...members], lead_bot_id: lead, bots_can_talk: $('#r-talk', el).checked };
      if (!payload.name) return toast('Give the chat a name');
      if (!payload.members.length) return toast('Pick at least one bot');
      const saved = isNew ? await api('/api/rooms', { method: 'POST', body: payload }) : await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: payload });
      closeModal(); await refreshState(); openThread('room:' + saved.id);
    }
  });
}

const PRESETS = [['Every morning, 9am', '0 9 * * *'], ['Weekdays, 8am', '0 8 * * 1-5'], ['Every 2 hours', '0 */2 * * *'], ['Every hour', '0 * * * *'], ['Mondays, 9am', '0 9 * * 1'], ['Every evening, 6pm', '0 18 * * *']];
function routinesModal(b) {
  const el = modal(`<div class="modal-head"><h2>Routines</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p class="muted">Things ${esc(b.name)} does on a schedule, even when the app is closed.</p>
    <div id="rt-list" class="stack-list"></div>
    <div class="panel">
      <label class="field">What should it do?<textarea id="rt-prompt" rows="2" placeholder="Triage my inbox and draft replies to clients."></textarea></label>
      <label class="field">When (cron: minute hour day month weekday)<input id="rt-cron" class="code" value="0 9 * * *"></label>
      <label class="toggle-row"><span class="m-text"><b>Quiet check</b><span>Only tell me if something needs attention. When all is fine it leaves a small “✓ All clear” line, with no notification.</span></span>
        <input type="checkbox" class="switch" id="rt-quiet"></label>
      <div class="chips">${PRESETS.map(([l, c]) => `<button type="button" class="chip" data-cron="${c}">${l}</button>`).join('')}</div>
      <div class="modal-foot"><button class="btn primary" id="rt-add">Add routine</button></div>
    </div>`, { wide: true });
  const draw = () => {
    const list = S.data.routines.filter((r) => r.bot_id === b.id);
    $('#rt-list', el).innerHTML = list.length ? list.map((r) => `
      <div class="panel">
        <div class="top"><code>${esc(r.cron)}</code>${r.quiet ? '<span class="chip">Quiet</span>' : ''}${r.enabled ? '' : '<span class="muted">Paused</span>'}
          <span class="grow"></span>
          <button class="btn small" data-run="${r.id}">Run now</button>
          <button class="btn small" data-toggle="${r.id}" data-en="${r.enabled}">${r.enabled ? 'Pause' : 'Resume'}</button>
          <button class="btn small danger" data-delr="${r.id}">Delete</button>
        </div>
        <div>${esc(r.prompt)}</div>
      </div>`).join('') : '<div class="muted">No routines yet.</div>';
  };
  draw();
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    if (t.dataset.cron) $('#rt-cron', el).value = t.dataset.cron;
    try {
      if (t.id === 'rt-add') {
        const prompt = $('#rt-prompt', el).value.trim();
        if (!prompt) return toast('Say what the routine should do');
        await api('/api/routines', { method: 'POST', body: { bot_id: b.id, cron: $('#rt-cron', el).value, prompt, quiet: $('#rt-quiet', el).checked } });
        $('#rt-prompt', el).value = '';
      }
      if (t.dataset.run) { await api(`/api/routines/${t.dataset.run}/run`, { method: 'POST' }); toast('Started'); closeModal(); return; }
      if (t.dataset.toggle) await api(`/api/routines/${t.dataset.toggle}`, { method: 'PATCH', body: { enabled: t.dataset.en === '1' ? 0 : 1 } });
      if (t.dataset.delr) await api(`/api/routines/${t.dataset.delr}`, { method: 'DELETE' });
      await refreshState(); draw(); renderMain();
    } catch (err) { toast(err.message); }
  });
}

async function memoryModal(b) {
  const { text } = await api(`/api/bots/${b.id}/memory`);
  const el = modal(`<div class="modal-head"><h2>Memory</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p class="muted">What ${esc(b.name)} has learned. It adds to this itself when you tell it a rule; edit freely.</p>
    <label class="field"><textarea id="mem" class="code" rows="14">${esc(text)}</textarea></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mem-save">Save</button></div>`, { wide: true });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'mem-save') { await api(`/api/bots/${b.id}/memory`, { method: 'PUT', body: { text: $('#mem', el).value } }); closeModal(); toast('Memory saved'); }
  });
}

// ---------- marketplace ----------
function pluginIcon(p, size = 40) {
  return `<span class="p-icon" style="width:${size}px;height:${size}px;background:${esc(p.color)};font-size:${Math.round(size * (p.icon.length > 1 ? 0.34 : 0.46))}px">${esc(p.icon)}</span>`;
}
async function marketModal(focus = '') {
  const el = modal(`<div class="market-top">
      <label class="search big">${ICON.search}<input id="mk-q" placeholder="Search plugins and bots" autocomplete="off"></label>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
    </div><div class="market-body" id="mk-body"><div class="muted">Loading…</div></div>`, { wide: true, cls: 'market' });
  S.market = await api('/api/marketplace');
  let query = '';
  const row = (p, kind) => {
    const isBot = kind === 'bot';
    const btn = isBot ? `<button class="btn pill" data-add-bot="${p.id}">${p.added ? 'Add again' : 'Add'}</button>`
      : p.kind === 'claude' ? `<button class="btn pill ${p.installed ? 'ghost' : ''}" data-connect="${p.id}">${p.installed ? 'Connected' : 'Connect'}</button>`
      : p.installed ? `<button class="btn pill ghost" data-manage="${p.id}">Installed</button>`
      : `<button class="btn pill" data-install="${p.id}">Add</button>`;
    return `<div class="m-row">${isBot ? avatar(p, 40) : pluginIcon(p)}
      <div class="m-text"><b>${esc(p.name)}</b><span>${esc(isBot ? p.role : p.desc)}</span></div>${btn}</div>`;
  };
  const section = (title, list, kind) => list.length ? `<section><h3>${title}</h3><div class="m-grid">${list.map((p) => row(p, kind)).join('')}</div></section>` : '';
  const draw = () => {
    const match = (p) => !query || `${p.name} ${p.role || ''} ${p.desc || ''} ${p.category}`.toLowerCase().includes(query);
    const T = S.market.templates.filter(match), P = S.market.plugins.filter(match);
    const cats = (list) => [...new Set(list.map((x) => x.category))];
    $('#mk-body', el).innerHTML = cats(T).map((c) => section(`${c} Bots`, T.filter((t) => t.category === c), 'bot')).join('')
      + section('Featured Plugins', P.filter((p) => p.category === 'Featured'), 'plugin')
      + cats(P).filter((c) => c !== 'Featured').map((c) => section(c, P.filter((p) => p.category === c), 'plugin')).join('')
      + (!T.length && !P.length ? '<div class="empty small">Nothing matches that search.</div>' : '');
    if (focus === 'plugins' && !query) { $('#mk-body', el).querySelector('section:nth-of-type(n+2) h3')?.closest('section'); const s = [...el.querySelectorAll('h3')].find((h) => h.textContent === 'Featured Plugins'); s?.scrollIntoView(); focus = ''; }
  };
  draw();
  $('#mk-q', el).addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); draw(); });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    try {
      if (t.dataset.addBot) {
        const saved = await api(`/api/templates/${t.dataset.addBot}/add`, { method: 'POST' });
        closeModal(); await refreshState(); await openThread('bot:' + saved.id);
        toast(`${saved.name} joined your team`);
      }
      if (t.dataset.connect) return connectModal(S.market.plugins.find((p) => p.id === t.dataset.connect));
      if (t.dataset.install) return installModal(S.market.plugins.find((p) => p.id === t.dataset.install));
      if (t.dataset.manage) return installModal(S.market.plugins.find((p) => p.id === t.dataset.manage));
    } catch (err) { toast(err.message); }
  });
}

function connectModal(p) {
  const el = modal(`<div class="modal-head"><div class="ph">${pluginIcon(p, 44)}<h2>${esc(p.name)}</h2></div><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p>${esc(p.desc)}</p>
    <p class="muted">${esc(p.name)} is a Claude connector. Connect it once in your Claude settings, signed in with the same account you use for Claude Code, and every bot can use it. Sending, deleting and creating events still wait for your approval.</p>
    <div class="modal-foot"><button class="btn" data-back>Back</button><a class="btn primary" href="${esc(p.connectUrl)}" target="_blank" rel="noopener">Open Claude connectors</a></div>`);
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); if (e.target.closest('[data-back]')) marketModal(); });
}

function installModal(p) {
  const el = modal(`<div class="modal-head"><div class="ph">${pluginIcon(p, 44)}<h2>${esc(p.name)}</h2></div><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p>${esc(p.desc)}</p>
    ${p.fields.length ? p.fields.map((f) => `<label class="field">${esc(f.label)}<input type="password" data-key="${esc(f.key)}" autocomplete="off" placeholder="${p.installed ? 'Saved · paste to replace' : ''}">${f.help ? `<span class="hint">Get one at ${esc(f.help)}</span>` : ''}</label>`).join('')
      : '<p class="muted">No setup needed.</p>'}
    <p class="muted">Stored on this computer in Nimbus’s database. After installing, switch it on for a bot from that bot’s plugin button.</p>
    <div class="modal-foot">
      ${p.installed ? '<button class="btn danger left" data-remove>Remove</button>' : ''}
      <button class="btn" data-back>Back</button>
      <button class="btn primary" data-save>${p.installed ? (p.fields.length ? 'Update' : 'Done') : 'Install'}</button>
    </div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.closest('[data-back]')) return marketModal();
    try {
      if (e.target.closest('[data-remove]')) {
        if (!confirm(`Remove ${p.name}? Bots using it lose access.`)) return;
        await api(`/api/plugins/${p.id}`, { method: 'DELETE' }); toast(`${p.name} removed`); return marketModal();
      }
      if (e.target.closest('[data-save]')) {
        if (p.installed && !p.fields.length) return marketModal();
        const secrets = {};
        el.querySelectorAll('[data-key]').forEach((i) => { secrets[i.dataset.key] = i.value; });
        await api(`/api/plugins/${p.id}`, { method: 'POST', body: { secrets } });
        toast(`${p.name} installed`);
        const cur = S.current?.type === 'bot' ? bot(S.current.id) : null;
        if (cur) { await api(`/api/bots/${cur.id}/plugins`, { method: 'PUT', body: { plugins: [...new Set([...cur.plugins, p.id])] } }); toast(`${p.name} is on for ${cur.name}`); }
        closeModal(); refreshState();
      }
    } catch (err) { toast(err.message); }
  });
}

async function botPluginsModal(b, fresh = false) {
  const market = S.market = await api('/api/marketplace' + (fresh ? '?fresh=1' : ''));
  const on = new Set(b.plugins);
  const usable = market.plugins.filter((p) => p.installed && p.kind !== 'claude');
  const known = market.plugins.filter((p) => p.kind === 'claude');
  // Everything connected on the Claude account, plus catalog connectors not connected yet.
  const conns = [...market.connectors.map((c) => ({ ...c, p: known.find((k) => k.connector?.name === c.name) })),
    ...known.filter((k) => !k.connector).map((k) => ({ name: k.name, status: 'not connected', p: k }))];
  const connIcon = (c) => c.p ? pluginIcon(c.p, 34) : `<span class="p-icon" style="width:34px;height:34px;background:#d97757">${esc(c.name[0])}</span>`;
  const el = modal(`<div class="modal-head"><h2>Plugins</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p class="muted">Tools ${esc(b.name)} can use. Risky actions (send, delete, pay) still ask you first.</p>
    <h3>Claude connectors</h3>
    <p class="muted">From your Claude account, shared by every bot. Manage them at <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">claude.ai/settings/connectors</a>. <button class="link" data-refresh>Refresh</button></p>
    <div class="stack-list">${conns.map((c) => `<div class="toggle-row">${connIcon(c)}<span class="m-text"><b>${esc(c.name)}</b><span>${c.status === 'connected' ? 'Connected · available to every bot' : esc(c.status[0].toUpperCase() + c.status.slice(1))}</span></span>
      ${c.status === 'connected' ? `<span class="pill-ok">${ICON.check}</span>` : '<a class="btn small" href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">Connect</a>'}</div>`).join('')}</div>
    <h3>Nimbus plugins</h3>
    <div class="stack-list">${usable.length ? usable.map((p) => `<label class="toggle-row">${pluginIcon(p, 34)}<span class="m-text"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></span>
      <input type="checkbox" class="switch" data-plugin="${p.id}" ${on.has(p.id) ? 'checked' : ''}></label>`).join('') : '<p class="muted">None installed yet. Browse plugins to add GitHub, Browser, Notion and more.</p>'}</div>
    <div class="modal-foot"><button class="btn left" data-browse>${ICON.grid} Browse plugins</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`, { wide: true });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.closest('[data-refresh]')) { toast('Checking your Claude connectors…'); return botPluginsModal(b, true); }
    if (e.target.closest('[data-browse]')) return marketModal('plugins');
    if (e.target.closest('[data-save]')) {
      const plugins = [...el.querySelectorAll('[data-plugin]')].filter((i) => i.checked).map((i) => i.dataset.plugin);
      await api(`/api/bots/${b.id}/plugins`, { method: 'PUT', body: { plugins } });
      closeModal(); await refreshState(); renderMain(); toast('Plugins saved. They apply from the next task.');
    }
  });
}

function appearanceModal() {
  const p = getPrefs();
  const ACCENTS = ['#3b82f6', '#7c5cf5', '#e84fa0', '#e2475f', '#f08a3c', '#f5c542', '#1f9d6b', '#3fb6a8', '#22d3ee'];
  const save = () => { const { mode, ...rest } = p; try { localStorage.setItem('nimbus.appearance', JSON.stringify(rest)); } catch {} applyTheme(); draw(); };
  const el = modal('<div id="ap"></div>', { wide: true });
  // A theme card is a tiny mock of the app in that theme's colors.
  const card = (id, th, attr) => { const v = th.vars || {}; const bg = v.bg || (th.scheme === 'dark' ? '#0e0e0f' : '#ffffff'), side = v.side || (th.scheme === 'dark' ? '#161617' : '#f6f6f7'),
      bub = v.bubble || (th.scheme === 'dark' ? '#232326' : '#f0f0f2'), user = v.user || (th.scheme === 'dark' ? '#e9e9ec' : '#151517'), text = v.text || (th.scheme === 'dark' ? '#ececee' : '#151517');
    return `<button class="theme-card" ${attr}="${id}" aria-pressed="${(attr === 'data-theme-pick' ? p.theme : attr === 'data-dark-pick' ? (p.darkTheme || 'dark') : (p.lightTheme || 'light')) === id}">
      <span class="tc-mock" style="background:${bg}"><i style="background:${side}"></i><b style="background:${bub}"></b><b style="background:${user};margin-left:auto"></b><u style="background:${th.accent}"></u></span>
      <span class="tc-name" style="color:inherit">${esc(th.name)}</span></button>`; };
  const list = (filter, attr) => Object.entries(THEMES).filter(([, th]) => !filter || th.scheme === filter).map(([id, th]) => card(id, th, attr)).join('');
  const draw = () => {
    $('#ap', el).innerHTML = `<div class="stack-list" style="gap:18px">
      <div class="modal-head"><h2>Appearance</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
      <label class="toggle-row"><span class="m-text"><b>Match my device</b><span>Switch between a dark and a light theme with your device’s setting.</span></span>
        <input type="checkbox" class="switch" id="ap-system" ${p.theme === 'system' ? 'checked' : ''}></label>
      ${p.theme === 'system'
        ? `<div class="field">Dark theme<div class="theme-grid">${list('dark', 'data-dark-pick')}</div></div>
           <div class="field">Light theme<div class="theme-grid">${list('light', 'data-light-pick')}</div></div>`
        : `<div class="field">Theme<div class="theme-grid">${list(null, 'data-theme-pick')}</div></div>`}
      <div class="field">Accent<div class="swatches">
        <button class="btn small ${p.accent ? '' : 'primary'}" data-accent="">Theme’s own</button>
        ${ACCENTS.map((c) => `<button class="swatch" data-accent="${c}" style="background:${c}" aria-pressed="${p.accent === c}" aria-label="Accent ${c}"></button>`).join('')}
        <label class="swatch custom" title="Any color" aria-pressed="${!!p.accent && !ACCENTS.includes(p.accent)}"><input type="color" id="ap-accent" value="${esc(p.accent || '#3b82f6')}" aria-label="Custom accent"></label></div></div>
      <div class="modal-foot"><button class="btn primary" data-close>Done</button></div></div>`;
  };
  draw();
  el.addEventListener('change', (e) => {
    if (e.target.id === 'ap-system') { p.theme = e.target.checked ? 'system' : (resolveThemeId(p) || 'dark'); save(); }
  });
  el.addEventListener('input', (e) => { if (e.target.id === 'ap-accent') { p.accent = e.target.value; const { mode, ...rest } = p; try { localStorage.setItem('nimbus.appearance', JSON.stringify(rest)); } catch {} applyTheme(); } });
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    if (t.dataset.themePick) p.theme = t.dataset.themePick;
    else if (t.dataset.darkPick) p.darkTheme = t.dataset.darkPick;
    else if (t.dataset.lightPick) p.lightTheme = t.dataset.lightPick;
    else if (t.dataset.accent !== undefined) p.accent = t.dataset.accent || null;
    else return;
    save();
  });
  // Turning "match my device" off keeps whichever theme is showing right now.
  function resolveThemeId(pr) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? (pr.darkTheme || 'dark') : (pr.lightTheme || 'light');
  }
}

// ---------- the Claude account the bots use ----------
// Either the server's own Claude Code login, or a token from `claude setup-token` pasted here (stored
// encrypted; it takes priority). Handy for switching accounts without a terminal on the server.
function claudeModal() {
  const c = S.data.claude || { mode: 'none' };
  const status = c.mode === 'token' ? `✅ Connected with a Claude token${c.at ? ` since ${new Date(c.at * 1000).toLocaleDateString()}` : ''}. All bots use this account.`
    : c.mode === 'login' ? '✅ Using the server’s own Claude Code login. Paste a token below to use a different account instead.'
    : '⚠ No Claude account yet. Bots can’t run until you connect one.';
  const el = modal(`<div class="modal-head"><h2>Claude account</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p>${status}</p>
    <ol class="steps-list">
      <li>On any computer with Claude Code, open a terminal and run <code>claude setup-token</code>. No Claude Code? <code>npm install -g @anthropic-ai/claude-code</code></li>
      <li>Sign in with your Claude account (Pro or Max) in the browser window that opens.</li>
      <li>Copy the line that starts with <code>sk-ant-oat</code> and paste it here.</li>
    </ol>
    <label class="field">${c.mode === 'token' ? 'Replace token' : 'Token'}<input id="cl-token" type="password" autocomplete="off" placeholder="sk-ant-oat01-…"></label>
    <p class="muted small">Stored encrypted on your Nimbus server and never shown again. The token lasts about a year.</p>
    <div class="modal-foot">${c.mode === 'token' ? '<button class="btn danger left" data-disconnect>Remove token</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>${c.mode === 'token' ? 'Replace' : 'Connect'}</button></div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    try {
      if (e.target.closest('[data-disconnect]')) {
        if (!confirm('Remove the Claude token? Bots fall back to the server’s own Claude login, if it has one.')) return;
        await api('/api/claude-account', { method: 'DELETE' }); closeModal(); await refreshState(); renderMain(); return toast('Token removed');
      }
      if (e.target.closest('[data-save]')) {
        await api('/api/claude-account', { method: 'PUT', body: { token: $('#cl-token', el).value } });
        closeModal(); await refreshState(); renderMain(); buzz(10); toast('Claude account connected');
      }
    } catch (err) { toast(err.message); }
  });
}

// ---------- activity log ----------
// Everything bots did lately: each run (who asked, how long, outcome) and each approval decision.
async function activityLogModal() {
  const el = modal(`<div class="modal-head"><h2>Activity log</h2>
      <div class="seg"><button data-days="1" aria-pressed="false">Today</button><button data-days="7" aria-pressed="true">7 days</button><button data-days="30" aria-pressed="false">30 days</button></div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div><div id="log-body" class="muted">Loading…</div>`, { wide: true });
  const load = async (days) => {
    const { runs, approvals } = await api('/api/activity?days=' + days);
    const byRun = {};
    for (const a of approvals) (byRun[a.run_id] ||= []).push(a);
    const src = (r) => r.parent_run ? 'from another bot' : r.thread.startsWith('room:') ? 'group chat' : /^\(Scheduled/.test(r.prompt) ? 'routine' : 'you';
    const icon = { done: '✓', error: '✗', stopped: '■', interrupted: '⚠', running: '…', queued: '…' };
    $('#log-body', el).innerHTML = runs.length ? `<div class="log">${runs.map((r) => {
      const b = bot(r.bot_id), secs = r.ended_at && r.started_at ? r.ended_at - r.started_at : null;
      return `<div class="log-row ${r.status}"><span class="li">${icon[r.status] || '·'}</span>${avatar(b, 22)}
        <div class="lt"><div><b>${esc(b?.name || 'Deleted bot')}</b> <span class="muted">${esc(src(r))} · ${stamp(r.started_at)}${secs != null ? ` · ${secs >= 60 ? Math.round(secs / 60) + ' min' : secs + 's'}` : ''} · ${esc(r.status)}</span></div>
        <div class="lp">${esc(r.prompt.replace(/^\(Scheduled[^)]*\)\s*/, ''))}</div>
        ${(byRun[r.id] || []).map((a) => `<div class="la ${a.status}">${ICON.lock} ${esc(describeTool(a.tool, (() => { try { return JSON.parse(a.input); } catch { return {}; } })()))} — <b>${esc(a.status)}</b>${a.note ? ` · “${esc(a.note)}”` : ''}</div>`).join('')}</div>
        <button class="btn small" data-open="${esc(r.thread)}">Open</button></div>`; }).join('')}</div>` : '<p class="muted">Nothing in this period.</p>';
  };
  load(7).catch((e) => { $('#log-body', el).textContent = e.message; });
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    if (t.dataset.days) { el.querySelectorAll('[data-days]').forEach((x) => x.setAttribute('aria-pressed', x === t)); load(Number(t.dataset.days)); }
    if (t.dataset.open) { closeModal(); openThread(t.dataset.open); }
  });
}

// ---------- server settings ----------
async function serverModal() {
  let v;
  try { v = await api('/api/settings'); } catch (err) { return toast(err.message); }
  const secret = (k) => `type="password" autocomplete="off" placeholder="${v[k] ? 'Saved · paste to replace' : ''}"`;
  const el = modal(`<div class="modal-head"><h2>Server settings</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <h3>Bot computers</h3>
    <p class="muted">The VM that runs each bot’s own desktop. See deploy/computer/README.md to set it up.</p>
    <label class="field">Agent URL<input id="s-agent_url" value="${esc(v.agent_url)}" placeholder="http://<computer-vm-ip>:8788"></label>
    <label class="field">Agent token<input id="s-agent_token" ${secret('agent_token')}></label>
    <label class="field">Callback URL<input id="s-callback_url" value="${esc(v.callback_url)}" placeholder="http://<this-server-ip>:8787"><span class="hint">How the VM reaches this Nimbus for approvals.</span></label>
    <h3>Proxmox</h3>
    <p class="muted">Shows host load and guest status in the Activity panel. A read-only (PVEAuditor) API token is enough.</p>
    <label class="field">Host<input id="s-pve_host" value="${esc(v.pve_host)}" placeholder="<proxmox-host-ip>"></label>
    <label class="field">Token ID<input id="s-pve_token_id" value="${esc(v.pve_token_id)}" placeholder="user@pve!tokenname"></label>
    <label class="field">Token secret<input id="s-pve_token_secret" ${secret('pve_token_secret')}></label>
    <div class="update-box"><button class="btn small" data-update>Update computers</button><span class="muted" id="upd-status">Rebuilds them with the latest Claude Code and Chromium. Files, browsers and sign-ins are kept; computers restart.</span></div>
    <h3>Chats</h3>
    <label class="field">Auto-compact at (% of context)<input id="s-auto_compact_pct" type="number" min="0" max="95" value="${esc(v.auto_compact_pct || '20')}"><span class="hint">When a chat’s context passes this, Nimbus compacts it between messages. 0 turns it off. You can also type <code>/compact</code> in any chat.</span></label>
    <h3>Backups</h3>
    <p class="muted">Every night at 3:15 Nimbus saves an encrypted copy of all bots, chats, memories and settings (last 14 kept on this server).
      Set a target to also copy each backup to another machine. Keep the key file <code>~/opt/nimbus-backup.key</code> somewhere safe: backups can’t be opened without it.</p>
    <label class="field">Copy backups to (optional)<input id="s-backup_target" value="${esc(v.backup_target || '')}" placeholder="user@nas:/mnt/pool/nimbus-backups"><span class="hint">Over SSH, using this server’s key.</span></label>
    <div class="update-box"><button class="btn small" data-backup>Back up now</button><span class="muted" id="bk-status">Checking…</span></div>
    <div class="modal-foot"><button class="btn left" data-test>Test computer VM</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`);
  api('/api/backup').then(({ last }) => { const st = $('#bk-status', el); if (st) st.textContent = !last ? 'No backup yet.'
    : last.ok ? `Last backup ${timeAgo(Math.round(last.at / 1000))}: ${fmtSize(last.size)}${last.remote ? ', copied to ' + last.remote : ', on this server only'}` : `✗ Last backup failed: ${last.error}`; }).catch(() => {});
  const values = () => {
    const out = {};
    for (const k of Object.keys(v)) { const i = $('#s-' + k, el); if (!i) continue; out[k] = i.type === 'password' && !i.value ? (v[k] ? '__saved__' : '') : i.value; }
    return out;
  };
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    try {
      if (e.target.closest('[data-backup]')) {
        await api('/api/settings', { method: 'PUT', body: values() });
        $('#bk-status', el).textContent = 'Backing up…';
        const r = await api('/api/backup', { method: 'POST' });
        $('#bk-status', el).textContent = r.ok ? `✓ Saved ${fmtSize(r.size)}${r.remote ? ' and copied to ' + r.remote : ''}` : '✗ ' + r.error;
        return;
      }
      if (e.target.closest('[data-update]')) {
        if (!confirm('Update all bot computers now? Each one restarts, so any task running on a computer is interrupted. It takes a few minutes.')) return;
        await api('/api/computers/update', { method: 'POST' });
        const st = $('#upd-status', el), btn = e.target.closest('[data-update]');
        btn.disabled = true;
        const poll = async () => {
          const u = await api('/api/computers/update').catch(() => null);
          if (!document.body.contains(st)) return;
          if (u?.running) { st.textContent = 'Updating… ' + (u.log.trim().split('\n').pop() || ''); return setTimeout(poll, 4000); }
          btn.disabled = false;
          st.textContent = u?.ok ? '✓ Computers updated.' : '✗ Update failed: ' + (u?.log.trim().split('\n').pop() || 'unknown error');
          compAt = 0;
        };
        st.textContent = 'Updating…'; return poll();
      }
      if (e.target.closest('[data-test]')) {
        await api('/api/settings', { method: 'PUT', body: values() });
        const h = await api('/api/settings/test-agent', { method: 'POST' });
        return toast(h.ok ? 'Computer VM is reachable' : 'Computer VM answered, but isn’t healthy');
      }
      if (e.target.closest('[data-save]')) {
        await api('/api/settings', { method: 'PUT', body: values() });
        pveAt = 0; closeModal(); await refreshState(); toast('Settings saved');
      }
    } catch (err) { toast(err.message); }
  });
}

// ---------- bot computers ----------
async function computerModal(b) {
  if (!window.isSecureContext && !S.httpsPort) S.httpsPort = (await api('/api/https-port').catch(() => ({}))).port;
  const el = modal(`<div class="modal-head"><h2>${esc(b.name)}’s computer</h2>
      <div class="seg cm-tabs"><button data-tab="screen" aria-pressed="true">Screen</button><button data-tab="files" aria-pressed="false">Files</button></div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div id="cm-body"><div class="muted">Checking…</div></div>`, { wide: true, cls: 'computer' });
  let tab = 'screen', dir = 'Downloads', info = null;
  const drawScreen = (c) => {
    $('#cm-body', el).innerHTML = !c.exists
      ? `<p>${esc(b.name)} doesn’t have a computer yet. It gets one automatically on its next task, or you can start it now to sign it into websites first.</p>
         <div class="modal-foot"><button class="btn primary" data-start>Start computer</button></div>`
      : !c.running
      ? `<p>😴 ${esc(b.name)}’s computer is asleep to save memory. It wakes up by itself on the next task, with its files, browser and sign-ins as they were.</p>
         <div class="modal-foot"><button class="btn primary" data-start>Wake it now</button></div>`
      : !window.isSecureContext
      ? `<p>The desktop needs a secure (HTTPS) connection, and this page is plain HTTP.</p>
         <p class="muted">Open Nimbus over HTTPS instead. The first time, your browser warns that the certificate isn’t trusted: choose <b>Advanced → Proceed</b>. It’s Nimbus’s own certificate on your network.</p>
         <div class="modal-foot"><a class="btn primary" href="https://${location.hostname}:${S.httpsPort || 8443}/#bot:${b.id}">Open Nimbus over HTTPS</a></div>`
      : `<div class="screen"><iframe src="/computer/${b.id}/" title="${esc(b.name)}’s screen" allow="clipboard-read; clipboard-write"></iframe></div>
         <div class="cm-info">
           <span class="muted">Shown through Nimbus, so no sign-in needed. Direct link: ${esc(c.url)} (user <code>${esc(c.user)}</code>, password <button class="link" data-reveal="${esc(c.password)}">show</button>)</span>
           <span class="grow"></span>
           <a class="btn small" href="/computer/${b.id}/" target="_blank" rel="noopener">Open in new tab</a>
           <button class="btn small danger" data-delete>Delete computer</button>
         </div>
         <p class="muted">You can use this screen yourself, for example to sign ${esc(b.name)} into a website. Anything the bot opens in its browser shows up here.</p>`;
  };
  // Files: the bot's home folder on its computer. Downloads first, since that's where browser downloads land.
  const drawFiles = async () => {
    const body = $('#cm-body', el);
    if (!info?.exists) { body.innerHTML = `<p class="muted">${esc(b.name)} doesn’t have a computer yet.</p>`; return; }
    body.innerHTML = '<div class="muted">Loading files…</div>';
    let r;
    try { r = await api(`/api/bots/${b.id}/files?dir=${encodeURIComponent(dir)}`); } catch (err) { body.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
    const parts = r.dir ? r.dir.split('/') : [];
    const crumbs = [`<button class="link" data-dir="">Home</button>`, ...parts.map((p, i) => `<button class="link" data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`)].join(' / ');
    const hidden = new Set(['browser-profile', 'ssl', 'Templates', 'Public']);
    const nimbusFiles = new Set(['CLAUDE.md', 'MEMORY.md', 'ask-bot.mjs']); // Nimbus's own files in ~/work
    const items = r.items.filter((it) => (r.dir ? !(r.dir === 'work' && nimbusFiles.has(it.name)) : !hidden.has(it.name)));
    body.innerHTML = `<div class="files-bar"><span>${crumbs}</span><span class="grow"></span>
        ${['Downloads', 'work', 'Desktop'].map((d) => `<button class="btn small ${r.dir === d ? 'primary' : ''}" data-dir="${d}">${d === 'work' ? 'Bot’s work' : d}</button>`).join('')}
        <button class="icon-btn" data-dir="${esc(r.dir)}" title="Refresh" aria-label="Refresh">↻</button></div>
      ${r.error ? `<p class="muted">${esc(r.error === 'Folder not found' ? 'This folder is empty or doesn’t exist yet.' : r.error)}</p>` : ''}
      <div class="file-list">${items.length ? items.map((it) => {
        const rel = (r.dir ? r.dir + '/' : '') + it.name;
        return it.dir
          ? `<button class="file-row" data-dir="${esc(rel)}"><span class="fi">📁</span><span class="fn">${esc(it.name)}</span><span class="fm">${timeAgo(it.mtime)}</span></button>`
          : `<a class="file-row" href="/api/bots/${b.id}/file?path=${encodeURIComponent(rel)}" download><span class="fi">📄</span><span class="fn">${esc(it.name)}</span><span class="fm">${fmtSize(it.size)} · ${timeAgo(it.mtime)}</span><span class="fd">⬇</span></a>`;
      }).join('') : (r.error ? '' : '<p class="muted">Nothing here yet. When the bot downloads or saves files here, you can download them.</p>')}</div>`;
  };
  const draw = () => (tab === 'screen' ? drawScreen(info) : drawFiles());
  const load = async (method = 'GET') => {
    try { info = await api(`/api/bots/${b.id}/computer`, { method }); draw(); }
    catch (err) { $('#cm-body', el).innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  };
  load();
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; el.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', x === tb)); return info ? draw() : load(); }
    const dv = e.target.closest('[data-dir]');
    if (dv) { dir = dv.dataset.dir; return drawFiles(); }
    const rv = e.target.closest('[data-reveal]');
    if (rv) { rv.outerHTML = `<code class="secret-inline">${esc(rv.dataset.reveal)}</code>`; return; }
    if (e.target.closest('[data-start]')) { $('#cm-body', el).innerHTML = '<div class="muted">Starting… this can take up to a minute.</div>'; return load('POST'); }
    if (e.target.closest('[data-delete]')) {
      if (!confirm(`Delete ${b.name}’s computer? Its files, browser and sign-ins are erased. The bot stays, and works on this PC until you turn “Own computer” back on.`)) return;
      try { await api(`/api/bots/${b.id}/computer`, { method: 'DELETE' }); closeModal(); await refreshState(); renderMain(); toast('Computer deleted'); }
      catch (err) { toast(err.message); }
    }
  });
}

// ---------- two-factor ----------
function loadQrLib() {
  if (window.QRCode) return Promise.resolve();
  return new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    sc.onload = ok; sc.onerror = fail; document.head.append(sc);
  });
}
async function mfaModal() {
  const st = await api('/api/mfa');
  const head = `<div class="modal-head"><h2>Two-factor authentication</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>`;
  if (!st.available) {
    const el = modal(`${head}<p>You’re signed in with the shared password. Authenticator codes are for email + password accounts (set NIMBUS_ALLOWED_EMAILS).</p><div class="modal-foot"><button class="btn primary" data-close>Done</button></div>`);
    return el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  }
  if (st.enabled) {
    const el = modal(`${head}<p><span class="on-pill">On</span> Signing in with your password also asks for a code from your authenticator app.</p>
      <p class="muted">${st.recoveryLeft} of 8 recovery codes left.</p>
      <details class="adv"><summary>Turn off two-factor</summary>
        <label class="field">Password<input type="password" id="mf-pw" autocomplete="current-password"></label>
        <label class="field">Current code (or a recovery code)<input id="mf-code" inputmode="numeric" autocomplete="one-time-code"></label>
        <div class="modal-foot"><button class="btn danger" id="mf-off">Turn off</button></div>
      </details>
      <div class="modal-foot"><button class="btn primary" data-close>Done</button></div>`);
    return el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) return closeModal();
      if (e.target.id === 'mf-off') {
        try { await api('/api/mfa/disable', { method: 'POST', body: { password: $('#mf-pw', el).value, code: $('#mf-code', el).value } }); closeModal(); toast('Two-factor is off'); }
        catch (err) { toast(err.message); }
      }
    });
  }
  const setup = await api('/api/mfa/setup', { method: 'POST' });
  const el = modal(`${head}
    <p>1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</p>
    <div class="qr-wrap"><div id="mf-qr"></div></div>
    <details class="adv"><summary>Can’t scan? Enter this key instead</summary><code class="secret">${esc(setup.secret.match(/.{1,4}/g).join(' '))}</code></details>
    <label class="field">2. Enter the 6-digit code the app shows<input id="mf-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mf-on">Turn on</button></div>`);
  loadQrLib().then(() => new window.QRCode($('#mf-qr', el), { text: setup.uri, width: 184, height: 184, colorDark: '#000000', colorLight: '#ffffff' }))
    .catch(() => { $('#mf-qr', el).innerHTML = '<p class="muted">Couldn’t load the QR code. Use the key below instead.</p>'; el.querySelector('.adv').open = true; });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.id !== 'mf-on') return;
    try {
      const { recovery } = await api('/api/mfa/enable', { method: 'POST', body: { code: $('#mf-code', el).value } });
      const done = modal(`<div class="modal-head"><h2>Two-factor is on</h2></div>
        <p>Save these recovery codes somewhere safe, like a password manager. Each one works once if you lose your phone. You won’t see them again.</p>
        <pre class="codes">${recovery.map(esc).join('\n')}</pre>
        <div class="modal-foot"><button class="btn" id="mf-copy">Copy</button><button class="btn primary" data-close>I saved them</button></div>`, { sticky: true });
      done.addEventListener('click', (ev) => {
        if (ev.target.id === 'mf-copy') navigator.clipboard?.writeText(recovery.join('\n')).then(() => toast('Copied'), () => toast('Copy failed; select and copy them instead'));
        if (ev.target.closest('[data-close]')) closeModal();
      });
    } catch (err) { toast(err.message); }
  });
}

function rejectModal(id) {
  const el = modal(`<div class="modal-head"><h2>Reject</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <label class="field">Tell the bot why or what to do instead (optional)<textarea id="rj" rows="3" placeholder="Don't offer a discount above 10%."></textarea></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="rj-go">Reject</button></div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'rj-go') { await decide(id, 'reject', { note: $('#rj', el).value.trim() }); closeModal(); }
  });
}
async function decide(id, decision, extra = {}) {
  try { await api(`/api/approvals/${id}`, { method: 'POST', body: { decision, ...extra } }); }
  catch (e) { toast(e.message); }
}

// ---------- live documents (block editor) ----------
// A document is a list of blocks with stable ids. Click a block to edit it; bots edit through operations
// and you see their changes appear live. If a bot changes the block you're editing, you choose whose text
// to keep. Comments anchor to a block and the quoted words.
const DOC = { id: null, d: null, editing: null, panel: '', flash: new Set() };
const docInline = (t) => esc(t)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
function docBlockMd(b) {
  const a = b.attrs || {};
  switch (b.type) {
    case 'heading': return '#'.repeat(a.level || 2) + ' ' + b.md;
    case 'quote': return b.md.split('\n').map((l) => '> ' + l).join('\n');
    case 'code': return '```' + (a.lang || '') + '\n' + b.md + '\n```';
    case 'chart': return '```chart\n' + b.md + '\n```';
    case 'divider': return '---';
    case 'pending': return `<!-- pending: ${a.intent || ''} -->`;
    default: return b.md;
  }
}
function docTable(src) {
  const rows = src.split('\n').filter((l) => l.trim() && !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (!rows.length) return '';
  const [head, ...body] = rows;
  return `<div class="dt-wrap"><table><thead><tr>${head.map((c) => `<th>${docInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${docInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function docChart(svg) {
  // A sandboxed frame with no scripts and no network: the chart can't reach the app or the internet.
  const vb = svg.match(/viewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/);
  const ratio = vb ? `${vb[1]} / ${vb[2]}` : '16 / 9';
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;height:100%;background:#fff}svg{width:100%;height:100%;display:block}</style>${svg}`;
  return `<iframe class="doc-chart" sandbox="" referrerpolicy="no-referrer" style="aspect-ratio:${ratio}" srcdoc="${esc(html)}" title="Chart"></iframe>`;
}
function docMarkQuotes(html, b) {
  const cms = (DOC.d?.comments || []).filter((c) => c.block_id === b.id && !c.resolved && !c.parent && c.quote && !c.detached);
  for (const c of cms) { const q = esc(c.quote); const i = html.indexOf(q); if (i >= 0) html = html.slice(0, i) + `<mark class="cm" data-cm="${c.id}">${q}</mark>` + html.slice(i + q.length); }
  return html;
}
function docBlockHtml(b) {
  const a = b.attrs || {};
  const list = (tag, re) => `<${tag}>${b.md.split('\n').filter((l) => l.trim()).map((l) => `<li style="margin-left:${Math.min(4, Math.floor((l.match(/^\s*/)[0].length) / 2)) * 1.4}em">${docInline(l.replace(re, ''))}</li>`).join('')}</${tag}>`;
  let h;
  switch (b.type) {
    case 'heading': h = `<h${Math.min(4, a.level || 2)}>${docInline(b.md)}</h${Math.min(4, a.level || 2)}>`; break;
    case 'bullets': h = list('ul', /^\s*[-*+] /); break;
    case 'numbered': h = list('ol', /^\s*\d+[.)] /); break;
    case 'todo': h = `<ul class="todo">${b.md.split('\n').filter((l) => l.trim()).map((l, i) => { const done = /\[[xX]\]/.test(l); return `<li class="${done ? 'done' : ''}"><input type="checkbox" data-todo="${i}" ${done ? 'checked' : ''}><span>${docInline(l.replace(/^\s*[-*+] \[[ xX]\] /, ''))}</span></li>`; }).join('')}</ul>`; break;
    case 'quote': h = `<blockquote>${docInline(b.md).replace(/\n/g, '<br>')}</blockquote>`; break;
    case 'code': h = `<pre><code>${esc(b.md)}</code></pre>`; break;
    case 'table': h = docTable(b.md); break;
    case 'divider': h = '<hr>'; break;
    case 'chart': h = docChart(b.md); break;
    case 'pending': h = `<div class="pending"><span class="shimmer">${esc(a.intent || 'Writing…')}</span><i></i><i></i><i></i></div>`; break;
    default: h = `<p>${docInline(b.md).replace(/\n/g, '<br>')}</p>`;
  }
  const n = (DOC.d?.comments || []).filter((c) => c.block_id === b.id && !c.resolved).length;
  return `<div class="blk ${b.type} ${DOC.flash.has(b.id) ? 'flash' : ''}" data-bid="${b.id}">
    <div class="blk-gutter"><button class="blk-btn" data-blk-add title="Add a block below">+</button><button class="blk-btn" data-blk-menu title="More">⋮</button></div>
    <div class="blk-body">${docMarkQuotes(h, b)}</div>${n ? `<button class="blk-cm" data-blk-comments title="Comments">💬 ${n}</button>` : ''}</div>`;
}
function renderDoc() {
  const el = $('#docpane'), d = DOC.d;
  if (!d) return;
  const editingEl = DOC.editing && el.querySelector(`.blk[data-bid="${DOC.editing}"] textarea, .blk-new textarea`);
  const keep = editingEl ? { id: DOC.editing, value: editingEl.value, start: editingEl.selectionStart } : null;
  const scroll = el.querySelector('.doc-scroll')?.scrollTop || 0;
  const created = d.created_at ? new Date(d.created_at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const author = d.bot_id ? bot(d.bot_id)?.name : userName();
  const open = (d.comments || []).filter((c) => !c.resolved).length;
  el.innerHTML = `
    <div class="doc-head">
      <span class="doc-name">${esc(d.title)}</span>
      <div class="doc-tools">
        <button class="icon-btn" data-doc-panel="comments" title="Comments" aria-label="Comments">💬${open ? `<i class="count">${open}</i>` : ''}</button>
        <button class="icon-btn" data-doc-panel="history" title="Version history" aria-label="History">${ICON.clock}</button>
        <button class="btn pill small" data-doc-export>Export</button>
        <button class="icon-btn" data-doc-wide title="Wider" aria-label="Wider">↔</button>
        <button class="icon-btn" data-doc-close aria-label="Close">${ICON.close}</button>
      </div>
    </div>
    <div class="doc-main">
      <div class="doc-scroll"><article class="doc">
        <h1 class="doc-title" contenteditable="true" spellcheck="false" data-doc-title>${esc(d.title)}</h1>
        <div class="doc-meta"><span class="chip">📅 ${esc(created)}</span><span class="chip">@${esc(author || 'You')}</span><span class="muted small">rev ${d.rev}</span></div>
        ${d.blocks.map(docBlockHtml).join('')}
        <button class="doc-add-end" data-blk-add-end>+ Add a block</button>
      </article></div>
      ${DOC.panel ? `<div class="doc-side">${DOC.panel === 'history' ? '<div class="muted">Loading…</div>' : docCommentsHtml()}</div>` : ''}
    </div>`;
  el.querySelector('.doc-scroll').scrollTop = scroll;
  if (DOC.panel === 'history') loadDocHistory();
  if (keep) {
    const blk = el.querySelector(`.blk[data-bid="${keep.id}"]`);
    if (blk) { docEditBlock(blk, keep.value); const ta = blk.querySelector('textarea'); ta.setSelectionRange(keep.start, keep.start); }
  }
  DOC.flash.clear();
}
function docCommentsHtml() {
  const cs = DOC.d.comments || [];
  const roots = cs.filter((c) => !c.parent);
  const replies = (id) => cs.filter((c) => c.parent === id);
  const one = (c) => `<div class="cm-item ${c.resolved ? 'resolved' : ''}" data-cm-id="${c.id}">
      ${c.quote ? `<div class="cm-quote ${c.detached ? 'detached' : ''}" data-cm-goto="${esc(c.block_id || '')}">“${esc(c.quote)}”${c.detached ? ' · text changed' : ''}</div>` : ''}
      <div class="cm-by"><b>${esc(c.author)}</b> <span class="muted">${timeAgo(c.created_at)}</span></div><div class="cm-body">${docInline(c.body)}</div>
      ${replies(c.id).map((r) => `<div class="cm-reply"><b>${esc(r.author)}</b> ${docInline(r.body)}</div>`).join('')}
      ${c.resolved ? '<div class="muted small">Resolved</div>' : `<div class="cm-actions"><input placeholder="Reply…" data-cm-reply="${c.id}"><button class="btn pill small" data-cm-resolve="${c.id}">Resolve</button></div>`}</div>`;
  return `<div class="doc-side-head"><b>Comments</b><span class="muted small">Select text in a block, then ⋮ → Comment</span></div>
    ${roots.length ? roots.sort((a, b) => a.resolved - b.resolved).map(one).join('') : '<div class="muted">No comments yet.</div>'}`;
}
async function loadDocHistory() {
  const side = $('#docpane .doc-side');
  const vs = await api(`/api/docs/${DOC.id}/versions`).catch(() => []);
  if (!side || DOC.panel !== 'history') return;
  side.innerHTML = `<div class="doc-side-head"><b>Version history</b></div>` + vs.map((v) => `
    <div class="ver"><div><b>Version ${v.rev}</b> <span class="muted small">${timeAgo(v.at)}</span></div><div class="muted small">${esc(v.actor || '')} · ${esc(v.summary || '')}</div>
    ${v.rev !== DOC.d.rev ? `<button class="btn pill small" data-doc-restore="${v.rev}">Restore</button>` : '<span class="muted small">Current</span>'}</div>`).join('');
}
async function openDoc(id) {
  DOC.id = id; DOC.editing = null;
  closeInfo(); $('#aside').classList.remove('open');
  const el = $('#docpane');
  el.classList.add('open');
  el.innerHTML = `<div class="doc-head"><span class="doc-name">Loading…</span><div class="doc-tools"><button class="icon-btn" data-doc-close aria-label="Close">${ICON.close}</button></div></div>`;
  try { DOC.d = await api(`/api/docs/${id}`); renderDoc(); }
  catch (e) { toast(e.message); closeDoc(); }
}
function closeDoc() { DOC.id = null; DOC.d = null; DOC.editing = null; $('#docpane').classList.remove('open', 'wide'); }
async function reloadDoc(flashIds = []) {
  if (!DOC.id) return;
  const d = await api(`/api/docs/${DOC.id}`).catch(() => null);
  if (!d || !DOC.id) return;
  flashIds.forEach((x) => DOC.flash.add(x));
  DOC.d = d;
  renderDoc();
}
async function docOps(payload) {
  try { const r = await api(`/api/docs/${DOC.id}/ops`, { method: 'POST', body: payload }); return r; }
  catch (e) { toast(e.message); throw e; }
}
// Edit a block in place as Markdown. Ctrl/Cmd+Enter or clicking away saves; Esc cancels.
function docEditBlock(blk, value) {
  const id = blk.dataset.bid, b = DOC.d.blocks.find((x) => x.id === id);
  if (!b) return;
  DOC.editing = id;
  const body = blk.querySelector('.blk-body');
  body.innerHTML = `<textarea class="blk-edit" spellcheck="true">${esc(value ?? docBlockMd(b))}</textarea><div class="blk-hint muted small">Markdown · Ctrl+Enter to save · Esc to cancel</div>`;
  blk.classList.add('editing');
  const ta = body.querySelector('textarea');
  ta.dataset.hash = b.hash;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  fit(); ta.focus(); ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); DOC.editing = null; renderDoc(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); docSaveBlock(blk, ta); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (DOC.editing === id && document.activeElement !== ta && !blk.querySelector('.blk-conflict')) docSaveBlock(blk, ta); }, 150));
}
async function docSaveBlock(blk, ta, force = false) {
  const id = blk.dataset.bid, b = DOC.d.blocks.find((x) => x.id === id);
  const text = ta.value;
  if (!b || (!force && text === docBlockMd(b))) { DOC.editing = null; return renderDoc(); }
  const op = text.trim() ? { op: 'replace', target: { blocks: [id] }, with: { markdown: text } } : { op: 'delete', target: { blocks: [id] } };
  if (!force) op.ifHash = ta.dataset.hash;
  try {
    const r = await fetch(`/api/docs/${DOC.id}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [op] }) });
    const out = await r.json().catch(() => ({}));
    if (r.status === 409) {
      // Someone (usually a bot) changed this block while you typed. You decide.
      blk.querySelector('.blk-conflict')?.remove();
      blk.querySelector('.blk-body').insertAdjacentHTML('beforeend', `<div class="blk-conflict">This block changed while you were editing.
        <button class="btn pill small primary" data-conflict="mine">Keep mine</button><button class="btn pill small" data-conflict="theirs">Use the new version</button></div>`);
      return;
    }
    if (!r.ok) throw new Error(out.error || 'Save failed');
    DOC.editing = null;
    await reloadDoc();
  } catch (e) { toast(e.message); }
}
function docNewBlock(afterId) {
  document.querySelector('#docpane .blk-new')?.remove();
  const html = `<div class="blk blk-new"><div class="blk-body"><textarea class="blk-edit" placeholder="Write Markdown: ## Heading, - list, | table |, > quote…"></textarea><div class="blk-hint muted small">Ctrl+Enter to add · Esc to cancel</div></div></div>`;
  const ref = afterId ? $(`#docpane .blk[data-bid="${afterId}"]`) : $('#docpane .doc-add-end');
  ref.insertAdjacentHTML(afterId ? 'afterend' : 'beforebegin', html);
  const ta = $('#docpane .blk-new textarea');
  ta.focus();
  const save = async () => {
    const v = ta.value.trim();
    document.querySelector('#docpane .blk-new')?.remove();
    if (!v) return;
    await docOps({ ops: [{ op: 'insert', target: afterId ? { blocks: [afterId] } : { at: 'end' }, side: 'after', source: { markdown: v } }] }).catch(() => {});
    reloadDoc();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ta.closest('.blk-new').remove();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta && document.contains(ta)) save(); }, 150));
}
function docBlockMenu(btn, blk) {
  document.querySelector('.doc-menu')?.remove();
  const sel = String(getSelection() || '').trim();
  const quote = sel && blk.contains(getSelection().anchorNode) ? sel.slice(0, 300) : '';
  const m = document.createElement('div');
  m.className = 'popover doc-menu';
  m.innerHTML = [['comment', quote ? `Comment on “${esc(quote.slice(0, 24))}${quote.length > 24 ? '…' : ''}”` : 'Comment'], ['up', 'Move up'], ['down', 'Move down'], ['edit', 'Edit'], ['delete', 'Delete']]
    .map(([k, l]) => `<button data-dm="${k}"><span>${l}</span></button>`).join('');
  document.body.append(m);
  const r = btn.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-dm]')?.dataset.dm;
    m.remove();
    const id = blk.dataset.bid, i = DOC.d.blocks.findIndex((b) => b.id === id), b = DOC.d.blocks[i];
    if (k === 'edit') return docEditBlock(blk);
    if (k === 'delete') { await docOps({ ops: [{ op: 'delete', target: { blocks: [id] }, ifHash: b.hash }] }).catch(() => {}); return reloadDoc(); }
    if (k === 'up' && i > 0) { await docOps({ ops: [{ op: 'move', target: { blocks: [id] }, side: 'before', ref: DOC.d.blocks[i - 1].id }] }).catch(() => {}); return reloadDoc(); }
    if (k === 'down' && i < DOC.d.blocks.length - 1) { await docOps({ ops: [{ op: 'move', target: { blocks: [id] }, side: 'after', ref: DOC.d.blocks[i + 1].id }] }).catch(() => {}); return reloadDoc(); }
    if (k === 'comment') {
      const text = prompt(quote ? `Comment on “${quote}”` : 'Comment on this block');
      if (!text?.trim()) return;
      await api(`/api/docs/${DOC.id}/comments`, { method: 'POST', body: { blockId: id, quote, body: text } }).catch((err) => toast(err.message));
      DOC.panel = 'comments'; reloadDoc();
    }
  });
  setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
}
document.addEventListener('click', async (e) => {
  const pane = e.target.closest('#docpane');
  const open = e.target.closest('[data-doc-open]');
  if (open) { e.preventDefault(); return openDoc(open.dataset.docOpen); }
  if (!pane) return;
  const t = e.target;
  if (t.closest('[data-doc-close]')) return closeDoc();
  if (t.closest('[data-doc-wide]')) return pane.classList.toggle('wide');
  if (t.closest('[data-doc-panel]')) { const p = t.closest('[data-doc-panel]').dataset.docPanel; DOC.panel = DOC.panel === p ? '' : p; return renderDoc(); }
  if (t.closest('[data-doc-export]')) {
    document.querySelector('.doc-menu')?.remove();
    const m = document.createElement('div');
    m.className = 'popover doc-menu';
    m.innerHTML = [['docx', 'Word (.docx)'], ['pdf', 'PDF'], ['md', 'Markdown']].map(([f, l]) => `<a href="/api/docs/${DOC.id}/export/${f}" download><span>${l}</span></a>`).join('');
    document.body.append(m);
    const r = t.closest('[data-doc-export]').getBoundingClientRect();
    m.style.top = r.bottom + 4 + 'px'; m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!m.contains(ev.target)) { setTimeout(() => m.remove(), 200); document.removeEventListener('mousedown', off); } }), 0);
    return;
  }
  if (t.closest('[data-doc-restore]')) { const rev = t.closest('[data-doc-restore]').dataset.docRestore; if (!confirm(`Restore version ${rev}? The current text stays in the history.`)) return; await api(`/api/docs/${DOC.id}/restore`, { method: 'POST', body: { rev: Number(rev) } }).catch((err) => toast(err.message)); return reloadDoc(); }
  if (t.closest('[data-cm-resolve]')) { await api(`/api/docs/${DOC.id}/comments/${t.closest('[data-cm-resolve]').dataset.cmResolve}/resolve`, { method: 'POST', body: {} }); return reloadDoc(); }
  if (t.closest('[data-cm-goto]')) { const blk = pane.querySelector(`.blk[data-bid="${t.closest('[data-cm-goto]').dataset.cmGoto}"]`); blk?.scrollIntoView({ behavior: 'smooth', block: 'center' }); blk?.classList.add('flash'); setTimeout(() => blk?.classList.remove('flash'), 1600); return; }
  if (t.closest('mark.cm') || t.closest('[data-blk-comments]')) { DOC.panel = 'comments'; return renderDoc(); }
  const blk = t.closest('.blk');
  if (t.closest('[data-conflict]') && blk) {
    const ta = blk.querySelector('textarea');
    if (t.closest('[data-conflict]').dataset.conflict === 'mine') return docSaveBlock(blk, ta, true);
    DOC.editing = null; return reloadDoc();
  }
  if (t.closest('[data-blk-add-end]')) return docNewBlock(null);
  if (!blk || blk.classList.contains('blk-new')) return;
  if (t.closest('[data-blk-add]')) return docNewBlock(blk.dataset.bid);
  if (t.closest('[data-blk-menu]')) return docBlockMenu(t.closest('[data-blk-menu]'), blk);
  if (t.closest('[data-todo]')) {
    const b = DOC.d.blocks.find((x) => x.id === blk.dataset.bid), n = Number(t.dataset.todo);
    let k = -1;
    const md2 = b.md.split('\n').map((l) => (l.trim() && ++k === n ? l.replace(/\[([ xX])\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]')) : l)).join('\n');
    await docOps({ ops: [{ op: 'replace', target: { blocks: [b.id] }, ifHash: b.hash, with: { markdown: md2 } }] }).catch(() => {});
    return reloadDoc();
  }
  if (t.closest('a, iframe') || String(getSelection() || '').length) return;
  if (!blk.classList.contains('editing') && !DOC.editing) docEditBlock(blk);
});
document.addEventListener('keydown', async (e) => {
  const reply = e.target.closest?.('[data-cm-reply]');
  if (reply && e.key === 'Enter' && reply.value.trim()) {
    await api(`/api/docs/${DOC.id}/comments`, { method: 'POST', body: { parent: Number(reply.dataset.cmReply), body: reply.value } }).catch((err) => toast(err.message));
    reloadDoc();
  }
  const title = e.target.closest?.('[data-doc-title]');
  if (title && e.key === 'Enter') { e.preventDefault(); title.blur(); }
});
document.addEventListener('focusout', async (e) => {
  const title = e.target.closest?.('[data-doc-title]');
  if (!title || !DOC.d) return;
  const v = title.textContent.trim();
  if (v && v !== DOC.d.title) { await docOps({ ops: [], title: v }).catch(() => {}); reloadDoc(); }
});
async function docsModal() {
  const list = await api('/api/docs').catch(() => []);
  const el = modal(`<div class="modal-head"><h2>Documents</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div class="doc-list">${list.length ? list.map((d) => `<button class="card-item" data-doc-open="${d.id}">📄<span><b>${esc(d.title)}</b><small>${d.bot_id ? esc(bot(d.bot_id)?.name || '') + ' · ' : ''}${timeAgo(d.updated_at)} · rev ${d.rev}</small></span></button>`).join('') : '<div class="muted">No documents yet. Ask a bot to write one, or start your own.</div>'}</div>
    <div class="modal-foot"><button class="btn" data-close>Close</button><button class="btn primary" data-new-doc>New document</button></div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.closest('[data-doc-open]')) return closeModal();
    if (e.target.closest('[data-new-doc]')) { const d = await api('/api/docs', { method: 'POST', body: { title: 'Untitled', markdown: 'Start writing…' } }); closeModal(); openDoc(d.id); }
  });
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-open]');
  if (!e.target.closest('.popover') && !t?.dataset.act?.endsWith('menu')) closePopover();
  if (!t) {
    if (!e.target.closest('.side') && !e.target.closest('.aside')) { $('#side').classList.remove('open'); $('#aside').classList.remove('open'); }
    return;
  }
  if (t.closest('#modal-root')) return;
  const cur = S.current?.type === 'bot' ? bot(S.current.id) : null;
  if (t.dataset.open) return openThread(t.dataset.open);
  if (t.dataset.computer) { const cb = bot(t.dataset.computer); if (cb) return computerModal(cb); }
  if (t.dataset.copy) { const m = S.messages.find((x) => x.id === Number(t.dataset.copy)); await navigator.clipboard?.writeText(m?.body || '').catch(() => {}); buzz(6); return toast('Copied'); }
  if (t.dataset.edit) { const m = S.messages.find((x) => x.id === Number(t.dataset.edit)); const ta = $('#msg'); if (ta && m) { ta.value = m.body; autosize(ta); ta.focus(); } return; }
  if (t.dataset.retry) { const m = S.messages.find((x) => x.id === Number(t.dataset.retry)); if (m) await api(`/api/threads/${encodeURIComponent(threadKey())}/messages`, { method: 'POST', body: { text: m.body } }); return; }
  if (t.dataset.continue) { await api(`/api/threads/${encodeURIComponent(threadKey())}/messages`, { method: 'POST', body: { text: t.textContent === 'Try again' ? 'That failed. Please try again.' : 'Continue.' } }); return; }
  if (t.dataset.speak) return speak(t);
  if (t.dataset.hit) return openThread(t.dataset.hitThread).then(() => flashMessage(Number(t.dataset.hit)));
  if (t.dataset.approve || t.dataset.reject) buzz(12);
  if (t.dataset.approve) return decide(t.dataset.approve, 'approve', { remember: document.querySelector(`[data-remember="${t.dataset.approve}"]`)?.value || '' });
  if (t.dataset.reject) return rejectModal(t.dataset.reject);
  if (t.dataset.ctx) { e.preventDefault(); if (cur) openInfo(cur); return; }
  if (t.dataset.stop) { e.preventDefault(); return api(`/api/runs/${t.dataset.stop}/stop`, { method: 'POST' }); }
  if (t.dataset.unattach) { attachments = attachments.filter((a) => a.key !== t.dataset.unattach); return drawAttachments(); }
  const act = t.dataset.act;
  if (act) closePopover();
  switch (act) {
    case 'new-menu': e.stopPropagation(); return popover(t, [['new-bot', 'New bot', ICON.plus], ['new-room', 'New group chat', ICON.compose], ['market', 'Browse Marketplace', ICON.grid]]);
    case 'claude': return claudeModal();
    case 'docs': return docsModal();
    case 'user-menu': e.stopPropagation(); return popover(t, [['appearance', 'Appearance', ICON.gear], ['server', 'Server settings', ICON.monitor], ['log', 'Activity log', ICON.clock], ['docs', 'Documents', ICON.book], ['claude', S.data.claude?.mode === 'none' ? 'Connect Claude ⚠' : 'Claude account', ICON.plug], ['mfa', 'Two-factor authentication', ICON.lock], ['notify', 'Notifications', ICON.bell], ...(window.NimbusApp ? [['app-server', 'App: server address', ICON.gear]] : []), ['logout', 'Log out', ICON.close]]);
    case 'new-bot': return botModal();
    case 'edit-bot': return botModal(cur);
    case 'new-room': return roomModal();
    case 'edit-room': return roomModal(room(S.current.id));
    case 'routines': return routinesModal(cur);
    case 'memory': return memoryModal(cur);
    case 'plugins': return botPluginsModal(cur);
    case 'market': $('#side').classList.remove('open'); return marketModal();
    case 'appearance': return appearanceModal();
    case 'attach': return $('#file-pick').click();
    case 'dictate': return toggleDictation(t);
    case 'mfa': return mfaModal();
    case 'server': return serverModal();
    case 'log': return activityLogModal();
    case 'app-server': return window.NimbusApp?.changeServer();
    case 'computer': return computerModal(cur);
    case 'reset': await api(`/api/bots/${cur.id}/reset`, { method: 'POST' }); return;
    case 'side-recent': S.data.sideOrder = null; renderSide(); return api('/api/side-order', { method: 'PUT', body: { order: null } });
    case 'effort-menu': {
      e.stopPropagation(); closePopover();
      const r = t.getBoundingClientRect(), el = document.createElement('div');
      el.className = 'popover effort-pop';
      el.innerHTML = EFFORTS.map(([v, l]) => `<button data-effort="${v}" aria-pressed="${cur.effort === v}">${cur.effort === v ? ICON.check : '<i></i>'}<span>${l}</span></button>`).join('')
        + '<div class="pop-hint">Lower effort uses less of your plan.</div>';
      document.body.append(el);
      el.style.top = r.bottom + 6 + 'px';
      el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
      el.addEventListener('click', async (ev) => {
        const o = ev.target.closest('[data-effort]'); if (!o) return;
        closePopover(); buzz(8);
        await api(`/api/bots/${cur.id}`, { method: 'PATCH', body: { effort: o.dataset.effort } });
        await refreshState(); renderMain();
        toast(`${cur.name} will use ${o.textContent.trim().toLowerCase()} effort from the next task`);
      });
      return;
    }
    case 'menu': e.stopPropagation(); return $('#side').classList.toggle('open');
    case 'panel': e.stopPropagation(); $('#side').classList.remove('open'); closeInfo(); return $('#aside').classList.toggle('open');
    case 'info': e.stopPropagation(); return infoBot === cur?.id && $('#info').classList.contains('open') ? closeInfo() : cur && openInfo(cur);
    case 'logout': await api('/api/logout', { method: 'POST' }); location.href = '/login'; return;
    case 'notify':
      if (!('Notification' in window)) return toast('This browser doesn’t support notifications');
      if (!window.isSecureContext) return toast('Notifications need HTTPS. See the README for how to add it.');
      return Notification.requestPermission().then((r) => toast(r === 'granted' ? 'You’ll get a notification when a bot needs approval' : 'Notifications are off'));
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'file-pick') { addFiles(e.target.files); e.target.value = ''; return; }
  if (!e.target.matches('[data-effort-select]')) return;
  const cur = bot(S.current?.id);
  await api(`/api/bots/${cur.id}`, { method: 'PATCH', body: { effort: e.target.value } });
  await refreshState();
  toast(`${cur.name} will use ${e.target.selectedOptions[0].text.toLowerCase()} effort from the next task`);
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details.trace')) { const id = Number(e.target.closest('[data-mid]').dataset.mid); e.target.open ? openTraces.add(id) : openTraces.delete(id); }
}, true);
document.addEventListener('input', (e) => {
  if (e.target.id === 'msg') { autosize(e.target); slashHint(e.target.value); }
  if (e.target.id === 'side-search') { sideQuery = e.target.value.trim().toLowerCase(); refreshSideOnly(); }
});
let searchSeq = 0, searchTimer;
function searchMessages() {
  clearTimeout(searchTimer);
  if (sideQuery.length < 2) return;
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const r = await api('/api/search?q=' + encodeURIComponent(sideQuery)).catch(() => ({ results: [] }));
    const box = $('#side-hits'); if (!box || seq !== searchSeq) return;
    const who = (t) => t.startsWith('bot:') ? bot(t.slice(4))?.name : room(t.slice(5))?.name;
    box.innerHTML = `<h5>Messages</h5>` + (r.results.length ? r.results.map((h) => `<button class="side-hit" data-hit="${h.id}" data-hit-thread="${esc(h.thread)}">
      <span class="row1"><b>${esc(who(h.thread) || h.thread)}</b><span class="time">${stamp(h.at)}</span></span>
      <span class="sub">${esc(h.author === 'user' ? 'You: ' : '')}${esc(h.snippet)}</span></button>`).join('') : '<div class="side-empty">No messages match</div>');
  }, 250);
}
function refreshSideOnly() {
  renderSide();
  const i = $('#side-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
}
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'msg' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault(); $('#composer').requestSubmit();
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'composer') return;
  e.preventDefault();
  const ta = $('#msg'); const text = ta.value.trim();
  if (/^\/context$/i.test(text) && S.current?.type === 'bot') { ta.value = ''; autosize(ta); return openInfo(bot(S.current.id)); }
  if (/^\/(new|clear)$/i.test(text)) { ta.value = ''; autosize(ta); await api(`/api/bots/${S.current.id}/reset`, { method: 'POST' }); return; }
  if (attachments.some((a) => !a.id && !a.error)) return toast('Still uploading…');
  const files = attachments.filter((a) => a.id).map((a) => a.id);
  if (!text && !files.length) return;
  const kept = attachments;
  const sendBtn = $('.composer .send');
  sendBtn?.classList.remove('launch'); void sendBtn?.offsetWidth; sendBtn?.classList.add('launch');
  buzz(10);
  ta.value = ''; autosize(ta); $('#slash-hint')?.remove(); sessionDraft.delete(threadKey()); attachments = []; drawAttachments();
  try { await api(`/api/threads/${encodeURIComponent(threadKey())}/messages`, { method: 'POST', body: { text, files } }); kept.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)); }
  catch (err) { ta.value = text; attachments = kept; drawAttachments(); toast(err.message); }
});

// Paste images/files into the message box, or drop them anywhere on the chat.
document.addEventListener('paste', (e) => {
  if (e.target.id !== 'msg') return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
document.addEventListener('dragover', (e) => { if ($('#composer') && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('dropping');
  if (!$('#composer') || !e.dataTransfer?.files.length) return;
  e.preventDefault(); addFiles(e.dataTransfer.files);
});

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (/^(bot|room):\d+$/.test(h) && h !== threadKey()) openThread(h);
});

// ---------- boot ----------
applyTheme();
(async () => {
  await refreshState();
  const hash = location.hash.slice(1);
  const first = Object.entries(S.data.last).sort((a, b) => b[1].at - a[1].at)[0]?.[0];
  if (/^(bot|room):\d+$/.test(hash)) openThread(hash);
  else if (matchMedia('(min-width: 761px)').matches && (first || S.data.bots[0])) openThread(first || 'bot:' + S.data.bots[0].id);
  else renderMain();
  connect();
})();
