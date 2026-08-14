import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import jsQR, { QRCode as JSQRCode } from 'jsqr';
import { gzip, ungzip } from 'pako';
import './styles.css';

const PROTOCOL = 'RQFT';
const VERSION = 1;
const DEFAULT_CHUNK_SIZE = 350;
const DEFAULT_FRAME_MS = 140;
const MAX_FILE_SIZE = 32 * 1024 * 1024;

type FrameType = 'M' | 'D' | 'E';

type Manifest = {
  t: 'M';
  v: number;
  id: string;
  name: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  chunkSize: number;
  totalChunks: number;
  sha256: string;
  roundsPlanned: number;
};

type DataFrame = {
  t: 'D';
  v: number;
  id: string;
  seq: number;
  total: number;
  payload: string;
};

type EndFrame = {
  t: 'E';
  v: number;
  id: string;
  total: number;
  sha256: string;
};

type AnyFrame = Manifest | DataFrame | EndFrame;

const base64FromBytes = (bytes: Uint8Array) => {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

const bytesFromBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const randomId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

async function sha256(bytes: Uint8Array) {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function splitChunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) result.push(bytes.slice(i, i + size));
  return result;
}

function encodeFrame(frame: AnyFrame) {
  return JSON.stringify([PROTOCOL, VERSION, frame.t, frame.id, frame]);
}

function decodeFrame(text: string): AnyFrame | null {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== PROTOCOL) return null;
    const frame = value[4] as AnyFrame;
    if (value[1] !== VERSION || !frame || frame.v !== VERSION || frame.id !== value[3]) return null;
    if (!['M', 'D', 'E'].includes(frame.t)) return null;
    return frame;
  } catch {
    return null;
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function buildTransfer(file: File, chunkSize: number, rounds: number) {
  const original = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256(original);
  const compressed = gzip(original, { level: 6 });
  const chunks = splitChunks(compressed, chunkSize);
  const manifest: Manifest = {
    t: 'M', v: VERSION, id: randomId(), name: file.name, mime: file.type || 'application/octet-stream',
    originalSize: original.byteLength, compressedSize: compressed.byteLength,
    chunkSize, totalChunks: chunks.length, sha256: hash, roundsPlanned: rounds
  };
  return { manifest, chunks };
}

function App() {
  const [mode, setMode] = useState<'sender' | 'receiver'>('sender');
  return <div className="app"><header><div><div className="eyebrow">AIR-GAPPED • OPTICAL TRANSPORT</div><h1>Reliable QR File Transfer</h1><p>Repeatable rounds, deduplicated chunks, and end-to-end integrity verification.</p></div><div className="mode-switch"><button className={mode === 'sender' ? 'active' : ''} onClick={() => setMode('sender')}>Sender</button><button className={mode === 'receiver' ? 'active' : ''} onClick={() => setMode('receiver')}>Receiver</button></div></header>{mode === 'sender' ? <Sender /> : <Receiver />}</div>;
}

function Sender() {
  const [file, setFile] = useState<File | null>(null);
  const [rounds, setRounds] = useState(5);
  const [frameMs, setFrameMs] = useState(DEFAULT_FRAME_MS);
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof buildTransfer>> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [round, setRound] = useState(1);
  const [index, setIndex] = useState(-1);
  const [qr, setQr] = useState('');
  const [status, setStatus] = useState('Select a file to prepare the transfer.');
  const timer = useRef<number | null>(null);

  const prepare = async () => {
    if (!file) return;
    setStatus('Compressing and preparing chunks…');
    setPrepared(await buildTransfer(file, chunkSize, rounds));
    setRound(1); setIndex(-1); setQr('');
    setStatus('Ready. The receiver can start scanning before you begin.');
  };

  const renderFrame = async (payload: string) => {
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, payload, { errorCorrectionLevel: 'M', margin: 2, width: 700 });
    setQr(canvas.toDataURL('image/png'));
  };

  const start = async () => {
    if (!prepared) return;
    setPlaying(true); setRound(1); setIndex(-1);
    let r = 1;
    let i = -1;
    const tick = async () => {
      if (!prepared) return;
      let frame: AnyFrame;
      if (i === -1) {
        frame = prepared.manifest;
      } else if (i < prepared.chunks.length) {
        frame = { t: 'D', v: VERSION, id: prepared.manifest.id, seq: i, total: prepared.chunks.length, payload: base64FromBytes(prepared.chunks[i]) };
      } else {
        frame = { t: 'E', v: VERSION, id: prepared.manifest.id, total: prepared.chunks.length, sha256: prepared.manifest.sha256 };
      }
      await renderFrame(encodeFrame(frame));
      setRound(r); setIndex(i);
      if (i >= prepared.chunks.length) {
        if (r >= rounds) { setPlaying(false); setStatus(`Completed ${rounds} rounds.`); return; }
        r += 1; i = -1;
      } else i += 1;
      timer.current = window.setTimeout(tick, frameMs);
    };
    await tick();
  };

  const stop = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; setPlaying(false); setStatus('Paused. Start again to continue from the beginning of the configured rounds.'); };

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const progress = prepared && index >= 0 ? Math.min(100, ((index + 1) / prepared.chunks.length) * 100) : 0;

  return <section className="grid">
    <div className="panel controls">
      <h2>Send a file</h2>
      <label className="drop"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><strong>{file ? file.name : 'Choose a file'}</strong><span>{file ? formatBytes(file.size) : `Maximum ${formatBytes(MAX_FILE_SIZE)}`}</span></label>
      <div className="row"><label>Rounds<input type="number" min="1" max="50" value={rounds} onChange={(e) => setRounds(Math.max(1, Number(e.target.value)))} /></label><label>QR interval (ms)<input type="number" min="80" step="20" value={frameMs} onChange={(e) => setFrameMs(Math.max(80, Number(e.target.value)))} /></label><label>Chunk bytes<input type="number" min="100" max="700" step="50" value={chunkSize} onChange={(e) => setChunkSize(Math.max(100, Math.min(700, Number(e.target.value))))} /></label></div>
      <div className="actions"><button onClick={prepare} disabled={!file || playing}>Prepare transfer</button><button className="secondary" onClick={playing ? stop : start} disabled={!prepared}>{playing ? 'Pause' : 'Start rounds'}</button></div>
      <p className="status">{status}</p>
      {prepared && <div className="stats"><span>{prepared.manifest.totalChunks.toLocaleString()} chunks</span><span>{formatBytes(prepared.manifest.compressedSize)} compressed</span><span>SHA-256 {prepared.manifest.sha256.slice(0, 12)}…</span></div>}
      {prepared && <div className="progress"><div style={{ width: `${progress}%` }} /></div>}
      {prepared && <div className="round-status">Round <b>{round}</b> / {rounds} • Frame <b>{Math.max(index, 0)}</b> / {prepared.manifest.totalChunks}</div>}
    </div>
    <div className="panel qr-panel"><div className="qr-wrap">{qr ? <img src={qr} alt="QR transfer frame" /> : <div className="placeholder">QR will appear here</div>}</div><p>Keep this QR area visible to the receiver. Repeated rounds intentionally send duplicates; the receiver counts each chunk only once.</p></div>
  </section>;
}

function Receiver() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [running, setRunning] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [received, setReceived] = useState<Map<number, Uint8Array>>(new Map());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [scans, setScans] = useState(0);
  const [status, setStatus] = useState('Start the camera, then point it at the sender.');
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const seenRounds = useRef(0);
  const runningRef = useRef(false);
  const finalizingRef = useRef(false);
  const manifestRef = useRef<Manifest | null>(null);

  const progress = manifest ? (received.size / manifest.totalChunks) * 100 : 0;

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    runningRef.current = false;
    setRunning(false);
  };

  const processFrame = async (frame: AnyFrame) => {
    if (frame.t === 'M') {
      const activeManifest = manifestRef.current;
      if (!activeManifest || activeManifest.id !== frame.id) {
        manifestRef.current = frame;
        setManifest(frame); setReceived(new Map()); setResultUrl(null); seenRounds.current = 0; finalizingRef.current = false;
        setStatus(`Transfer ${frame.id} detected: ${frame.name} • ${frame.totalChunks.toLocaleString()} chunks.`);
      }
      return;
    }
    const activeManifest = manifestRef.current;
    if (!activeManifest || frame.id !== activeManifest.id) return;
    if (frame.t === 'D') {
      if (frame.seq < 0 || frame.seq >= activeManifest.totalChunks) return;
      let payload: Uint8Array;
      try {
        payload = bytesFromBase64(frame.payload);
      } catch {
        return;
      }
      setLastIndex(frame.seq);
      setReceived(prev => {
        if (prev.has(frame.seq)) return prev;
        const next = new Map(prev); next.set(frame.seq, payload); return next;
      });
      return;
    }
    if (frame.t === 'E') {
      if (frame.total !== activeManifest.totalChunks) return;
      seenRounds.current += 1;
      setStatus(`End marker seen. Unique chunks: ${received.size}/${activeManifest.totalChunks}. Continue scanning for another round.`);
    }
  };

  const scanLoop = async () => {
    const video = videoRef.current; const canvas = canvasRef.current;
    if (!video || !canvas || !runningRef.current) return;
    if (video.readyState >= 2) {
      const width = 960; const scale = width / video.videoWidth || 1;
      canvas.width = width; canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code: JSQRCode | null = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        setScans(x => x + 1);
        if (code?.data) { const frame = decodeFrame(code.data); if (frame) await processFrame(frame); }
      }
    }
    if (runningRef.current) rafRef.current = requestAnimationFrame(scanLoop);
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        runningRef.current = true; setRunning(true); setStatus('Scanning…');
      requestAnimationFrame(scanLoop);
    } catch (e) { setStatus(`Camera error: ${e instanceof Error ? e.message : 'permission denied'}`); }
  };

  const finalize = async () => {
    if (finalizingRef.current || !manifest || received.size !== manifest.totalChunks) return;
    finalizingRef.current = true;
    const compressed = new Uint8Array(manifest.compressedSize);
    let offset = 0;
    for (let i = 0; i < manifest.totalChunks; i++) { const chunk = received.get(i); if (!chunk) throw new Error(`Missing chunk ${i}`); compressed.set(chunk, offset); offset += chunk.length; }
    const original = ungzip(compressed);
    const hash = await sha256(original);
    if (hash !== manifest.sha256) { finalizingRef.current = false; setStatus(`Integrity failure. Expected ${manifest.sha256}, received ${hash}.`); return; }
    const blob = new Blob([original], { type: manifest.mime });
    setResultUrl(URL.createObjectURL(blob)); setStatus('Transfer complete — SHA-256 verified.'); stop();
  };

  useEffect(() => { if (manifest && received.size === manifest.totalChunks) void finalize(); }, [received.size, manifest]);
  useEffect(() => () => stop(), []);

  const missingCount = manifest ? manifest.totalChunks - received.size : 0;

  return <section className="grid">
    <div className="panel controls">
      <h2>Receive a file</h2>
      <video ref={videoRef} className="camera" playsInline muted /><canvas ref={canvasRef} hidden />
      <div className="actions"><button onClick={running ? stop : start}>{running ? 'Stop camera' : 'Start camera'}</button><button className="secondary" onClick={() => { setManifest(null); setReceived(new Map()); setResultUrl(null); setStatus('Receiver reset. Ready for another transfer.'); }} >Reset</button></div>
      <p className="status">{status}</p>
      {manifest && <><div className="file-card"><strong>{manifest.name}</strong><span>{formatBytes(manifest.originalSize)} original • {manifest.totalChunks.toLocaleString()} chunks</span><span>Unique received: {received.size.toLocaleString()} • Missing: {missingCount.toLocaleString()}</span></div><div className="progress"><div style={{ width: `${progress}%` }} /></div><div className="round-status">Last chunk: <b>{lastIndex ?? '—'}</b> • Camera scan iterations: <b>{scans.toLocaleString()}</b></div></>}
      {resultUrl && <a className="download" href={resultUrl} download={manifest?.name}>Download verified file</a>}
    </div>
    <div className="panel explanation"><h2>How reliability works</h2><div className="steps"><div><b>1</b><span>Sender sends every chunk in a round.</span></div><div><b>2</b><span>Receiver stores a chunk only once.</span></div><div><b>3</b><span>Duplicate chunks from later rounds are ignored.</span></div><div><b>4</b><span>When all chunks exist, the compressed stream is rebuilt.</span></div><div><b>5</b><span>SHA-256 of the original file must match before download.</span></div></div><p className="note">This version deliberately favors reliability over peak speed. It does not yet require a return channel or advanced FEC, so a sender can simply repeat the complete stream until the receiver reaches 100%.</p></div>
  </section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
