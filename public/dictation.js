// Voice dictation for the message box. Records the microphone as 16 kHz mono WAV in the browser and
// sends it to Nimbus, which transcribes it with whisper.cpp on the server (POST /api/transcribe).
// If the server can't transcribe, it falls back to the browser's own speech recognition when there is one.
const RATE = 16000, MAX_SECONDS = 300;

let rec = null; // { stream, ctx, node, chunks, inRate, started, timer, onLevel }

function toWav(chunks, inRate) {
  // Join, then downsample by averaging each output sample's window.
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = inRate / RATE, len = Math.floor(total / ratio);
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b; j++) sum += all[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}
function base64(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const isRecording = () => !!rec;

export async function startRecording({ onLevel, onLimit } = {}) {
  if (!window.isSecureContext) throw new Error('Dictation needs the HTTPS address (port 8443)');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t record audio');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  node.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(d));
    if (onLevel) { let p = 0; for (let i = 0; i < d.length; i += 64) p = Math.max(p, Math.abs(d[i])); onLevel(p); }
  };
  src.connect(node); node.connect(ctx.destination);
  rec = { stream, ctx, node, chunks, inRate: ctx.sampleRate, started: Date.now(),
    timer: setTimeout(() => onLimit?.(), MAX_SECONDS * 1000) };
}

function release() {
  const r = rec; rec = null;
  if (!r) return null;
  clearTimeout(r.timer);
  r.node.disconnect(); r.stream.getTracks().forEach((t) => t.stop()); r.ctx.close();
  return r;
}
export function cancelRecording() { release(); }

// Stops recording and returns the transcribed text.
export async function stopRecording(api) {
  const r = release();
  if (!r || !r.chunks.length) return '';
  if (Date.now() - r.started < 400) return ''; // a stray tap
  const wav = toWav(r.chunks, r.inRate);
  const { text } = await api('/api/transcribe', { method: 'POST', body: { audio: base64(wav) } });
  return text;
}

// Fallback: the browser's speech service (Chrome/Edge send audio to Google). Returns a stop() function.
export function browserDictation(onText, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const sr = new SR();
  sr.lang = 'en-US'; sr.interimResults = false; sr.continuous = true;
  sr.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText(e.results[i][0].transcript); };
  sr.onend = onEnd; sr.onerror = onEnd;
  sr.start();
  return () => sr.stop();
}
