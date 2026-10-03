import './styles.css';
import { mountBackground } from './background/background';
import { socket, wakeServer } from './net';
import { Board } from './puzzle/board';
import {
  type CreateRoomError,
  type JoinRoomError,
  type PieceCount,
  type PieceState,
  type PlayerId,
  type PlayerInfo,
  type RoomState,
  type Scores,
  DEFAULT_PIECE_COUNT,
  DIFFICULTY_LABELS,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_IMAGE_LONG_SIDE,
  PIECE_COUNTS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = {
  home: $('screen-home'),
  waiting: $('screen-waiting'),
  game: $('screen-game'),
};
const connPill = $('conn-pill');
const connText = $('conn-text');
const wakeBanner = $('wake-banner');
const fileInput = $<HTMLInputElement>('file-input');
const dropzone = $('dropzone');
const preview = $<HTMLImageElement>('preview');
const dzEmpty = $('dz-empty');
const createForm = $<HTMLFormElement>('create-form');
const createBtn = $<HTMLButtonElement>('create-btn');
const joinForm = $<HTMLFormElement>('join-form');
const joinBtn = $<HTMLButtonElement>('join-btn');
const codeInput = $<HTMLInputElement>('code-input');
const roomCodeEl = $('room-code');
const shareLink = $<HTMLInputElement>('share-link');
const copyBtn = $<HTMLButtonElement>('copy-btn');
const waitingThumb = $<HTMLImageElement>('waiting-thumb');
const waitingIcon = $('waiting-icon');
const waitingPresence = $('waiting-presence');
const waitingText = $('waiting-text');
const leaveBtn = $<HTMLButtonElement>('leave-btn');
const hudCode = $<HTMLButtonElement>('hud-code');
const hudScores = $('hud-scores');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const timerEl = $('timer');
const stage = $('stage');
const winOverlay = $('win-overlay');
const winImage = $<HTMLImageElement>('win-image');
const winTime = $('win-time');
const winResults = $('win-results');
const againBtn = $<HTMLButtonElement>('again-btn');
const confetti = $('confetti');
const toastEl = $('toast');
const hudExit = $<HTMLButtonElement>('hud-exit');
const winExit = $<HTMLButtonElement>('win-exit');
const confirmExit = $('confirm-exit');
const confirmExitOk = $<HTMLButtonElement>('confirm-exit-ok');
const confirmExitCancel = $<HTMLButtonElement>('confirm-exit-cancel');
const confirmExitText = $('confirm-exit-text');
const partnerLeft = $('partner-left');
const partnerLeftSolo = $<HTMLButtonElement>('partner-left-solo');
const partnerLeftExit = $<HTMLButtonElement>('partner-left-exit');

codeInput.maxLength = ROOM_CODE_LENGTH;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type ScreenName = keyof typeof screens;

interface PreparedImage {
  dataUrl: string;
  w: number;
  h: number;
}

let room: RoomState | null = null;
let myId: PlayerId | null = null;
let board: Board | null = null;
/** Bumped whenever a new board build starts so stale async builds are dropped. */
let boardToken = 0;
/** Board events that arrive while the board image is still loading. */
let pendingBoardEvents: ((b: Board) => void)[] = [];
let prepared: PreparedImage | null = null;
let createCount: PieceCount = DEFAULT_PIECE_COUNT;
let againCount: PieceCount = DEFAULT_PIECE_COUNT;
/** Local clock time the current game started (avoids server clock skew). */
let localStartedAt = 0;
let hasConnectedOnce = false;
let busy = false;
/** Points last shown in the HUD per player, to bump chips whose score changed. */
const shownPoints = new Map<PlayerId, number>();

const playerKey = (code: string) => `puzzle-player:${code}`;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showScreen(name: ScreenName): void {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  document.body.dataset.screen = name;
}

let toastTimer = 0;
function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  toastEl.textContent = message;
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 300);
  }, 3800);
}

function buildPills(container: HTMLElement, selected: PieceCount, onPick: (n: PieceCount) => void): void {
  container.innerHTML = '';
  for (const n of PIECE_COUNTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.dataset.value = String(n);
    b.innerHTML = `<span class="pill-n">${n}</span><span class="pill-l">${DIFFICULTY_LABELS[n]}</span>`;
    b.setAttribute('aria-pressed', String(n === selected));
    b.addEventListener('click', () => {
      for (const other of container.querySelectorAll('.pill')) other.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onPick(n);
    });
    container.appendChild(b);
  }
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function shareUrl(code: string): string {
  return `${location.origin}/?room=${code}`;
}

function setUrlRoom(code: string | null): void {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function colorOf(id: PlayerId): string | undefined {
  return room?.players.find((p) => p.id === id)?.color;
}

function renderPresence(): void {
  const players = room?.players ?? [];
  const html = players
    .map((p) => {
      const you = p.id === myId;
      const label = you ? 'You' : 'Partner';
      return `<span class="player ${p.connected ? '' : 'offline'}" title="${label}${p.connected ? '' : ' (disconnected)'}">
        <span class="player-dot" style="--c:${p.color}"></span>${label}</span>`;
    })
    .join('');
  waitingPresence.innerHTML = html;
  renderScores();

  const partner = players.find((p) => p.id !== myId);
  if (!partner) waitingText.textContent = 'Waiting for your partner to join…';
  else if (!partner.connected) waitingText.textContent = 'Your partner disconnected. Waiting for them to come back…';
  else waitingText.textContent = 'Partner connected! Starting…';
  board?.refreshHolders();
}

const pointsOf = (scores: Scores, id: PlayerId) => scores[id]?.points ?? 0;

function formatPoints(n: number): string {
  return `${n} ${Math.abs(n) === 1 ? 'pt' : 'pts'}`;
}

/** Live score chips in the HUD: you first, the sole leader gets a crown, changed chips bump. */
function renderScores(): void {
  const scores = room?.game?.scores ?? {};
  const players = [...(room?.players ?? [])].sort((a, b) => Number(b.id === myId) - Number(a.id === myId));
  const top = Math.max(...players.map((p) => pointsOf(scores, p.id)));
  const leaders = players.filter((p) => pointsOf(scores, p.id) === top);
  hudScores.innerHTML = '';
  for (const p of players) {
    const points = pointsOf(scores, p.id);
    const label = p.id === myId ? 'You' : 'Partner';
    const chip = document.createElement('span');
    chip.className = 'score-chip';
    chip.classList.toggle('offline', !p.connected);
    chip.classList.toggle('leader', players.length > 1 && leaders.length === 1 && leaders[0] === p);
    chip.title = `${label}: ${formatPoints(points)}`;
    chip.innerHTML = `<span class="player-dot" style="--c:${p.color}"></span><span class="score-label">${label}</span><span class="score-points">${points}</span>`;
    const prev = shownPoints.get(p.id);
    if (prev !== undefined && prev !== points) chip.classList.add(points > prev ? 'bump-up' : 'bump-down');
    shownPoints.set(p.id, points);
    hudScores.appendChild(chip);
  }
}

/** Win screen results: winner or tie banner plus each player's points and counts. */
function renderResults(): void {
  const scores = room?.game?.scores ?? {};
  const entries = Object.entries(scores).sort(([a], [b]) => Number(b === myId) - Number(a === myId));
  winResults.innerHTML = '';
  winResults.hidden = entries.length === 0;
  if (entries.length === 0) return;
  const ranked = [...entries].sort(([, a], [, b]) => b.points - a.points);
  const tie = ranked.length > 1 && ranked[0][1].points === ranked[1][1].points;
  const winnerId = ranked.length > 1 && !tie ? ranked[0][0] : null;
  const banner = document.createElement('div');
  banner.className = 'win-banner';
  if (tie) banner.textContent = "It's a tie!";
  else if (winnerId === myId) banner.textContent = 'You win!';
  else if (winnerId) banner.textContent = 'Partner wins!';
  else banner.textContent = 'Final score';
  winResults.appendChild(banner);
  for (const [id, s] of entries) {
    const inRoom = room?.players.some((p) => p.id === id);
    const label = id === myId ? 'You' : inRoom ? 'Partner' : 'Former partner';
    const row = document.createElement('div');
    row.className = 'result-row';
    row.classList.toggle('winner', id === winnerId);
    row.innerHTML = `<span class="player-dot" style="--c:${colorOf(id) ?? '#b9b0d6'}"></span>
      <span class="result-name">${label}</span>
      <span class="result-detail">${s.correct} correct, ${s.wrong} wrong</span>
      <span class="result-points">${formatPoints(s.points)}</span>`;
    winResults.appendChild(row);
  }
}

type ConnState = 'connecting' | 'waking' | 'online' | 'offline';
const CONN_TEXT: Record<ConnState, string> = {
  connecting: 'Connecting…',
  waking: 'Waking server…',
  online: 'Connected',
  offline: 'Reconnecting…',
};

function setConn(state: ConnState): void {
  connPill.dataset.state = state;
  connText.textContent = CONN_TEXT[state];
  wakeBanner.hidden = state !== 'waking';
  setBusy(busy);
}

function setBusy(b: boolean): void {
  busy = b;
  const offline = !socket.connected;
  createBtn.disabled = b || offline || !prepared;
  joinBtn.disabled = b || offline || codeInput.value.length !== ROOM_CODE_LENGTH;
  createBtn.textContent = b ? 'Working…' : 'Create room';
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error("Couldn't read that image. Try a JPG or PNG.");
    }
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    if (!sw || !sh) throw new Error("Couldn't read that image.");
    const k = Math.min(1, MAX_IMAGE_LONG_SIDE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k));
    const h = Math.max(1, Math.round(sh * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    let dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    for (const q of [0.7, 0.55]) {
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) break;
      dataUrl = canvas.toDataURL('image/jpeg', q);
    }
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error('That image is too large.');
    return { dataUrl, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleFile(file: File | undefined): Promise<void> {
  if (!file) return;
  try {
    prepared = await prepareImage(file);
    preview.src = prepared.dataUrl;
    preview.hidden = false;
    dzEmpty.hidden = true;
    dropzone.classList.add('has-image');
  } catch (err) {
    prepared = null;
    preview.hidden = true;
    dzEmpty.hidden = false;
    dropzone.classList.remove('has-image');
    toast((err as Error).message);
  }
  setBusy(busy);
}

fileInput.addEventListener('change', () => void handleFile(fileInput.files?.[0]));
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  void handleFile(e.dataTransfer?.files?.[0]);
});

// ---------------------------------------------------------------------------
// Create / join
// ---------------------------------------------------------------------------

const CREATE_ERRORS: Record<CreateRoomError, string> = {
  invalid_image: "The server couldn't use that image. Try another one.",
  image_too_large: 'That image is too large. Try a smaller one.',
  invalid_piece_count: 'Please pick a difficulty.',
};
const JOIN_ERRORS: Record<JoinRoomError, string> = {
  not_found: "That room doesn't exist (or has expired).",
  full: 'That room already has two players.',
};

buildPills($('difficulty'), createCount, (n) => (createCount = n));
buildPills($('again-difficulty'), againCount, (n) => (againCount = n));

let ackTimer = 0;
function armAckTimeout(): void {
  clearTimeout(ackTimer);
  ackTimer = window.setTimeout(() => {
    if (!busy) return;
    setBusy(false);
    toast("The server didn't answer. Check your connection and try again.");
  }, 15000);
}

createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!prepared || busy) return;
  setBusy(true);
  armAckTimeout();
  socket.emit(
    'createRoom',
    { image: prepared.dataUrl, imageW: prepared.w, imageH: prepared.h, pieceCount: createCount },
    (res) => {
      clearTimeout(ackTimer);
      setBusy(false);
      if (!res.ok) {
        toast(CREATE_ERRORS[res.error] ?? 'Could not create the room.');
        return;
      }
      enterRoom(res.playerId, res.state);
    },
  );
});

codeInput.addEventListener('input', () => {
  const allowed = new Set(ROOM_CODE_ALPHABET);
  codeInput.value = [...codeInput.value.toUpperCase()]
    .filter((ch) => allowed.has(ch))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);
  setBusy(busy);
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy || codeInput.value.length !== ROOM_CODE_LENGTH) return;
  joinRoom(codeInput.value, false);
});

function joinRoom(code: string, silent: boolean): void {
  // sessionStorage is per tab, so a second tab in the same browser joins as the partner
  // instead of stealing this tab's seat. localStorage only helps a reopened tab reclaim its seat.
  const stored = sessionStorage.getItem(playerKey(code)) ?? undefined;
  if (!silent) {
    setBusy(true);
    armAckTimeout();
  }
  const send = (playerId: PlayerId | undefined, allowFallback: boolean): void => {
    socket.emit('joinRoom', { roomCode: code, playerId }, (res) => {
      const fallback = localStorage.getItem(playerKey(code));
      if (!res.ok && res.error === 'full' && allowFallback && fallback) return send(fallback, false);
      clearTimeout(ackTimer);
      setBusy(false);
      if (!res.ok) {
        toast(JOIN_ERRORS[res.error] ?? 'Could not join that room.');
        if (silent || room?.code === code) leaveRoom();
        return;
      }
      enterRoom(res.playerId, res.state);
    });
  };
  send(stored, !stored);
}

function leaveRoom(): void {
  room = null;
  myId = null;
  destroyBoard();
  winOverlay.hidden = true;
  confetti.innerHTML = '';
  confirmExit.hidden = true;
  partnerLeft.hidden = true;
  waitingThumb.removeAttribute('src');
  winImage.removeAttribute('src');
  setUrlRoom(null);
  showScreen('home');
}

/** Give up our seat for good: tell the server, forget the stored id, and go home. */
function exitRoom(): void {
  const code = room?.code;
  if (code && myId) {
    socket.emit('leaveRoom', { roomCode: code, playerId: myId });
    sessionStorage.removeItem(playerKey(code));
    localStorage.removeItem(playerKey(code));
  }
  leaveRoom();
}

/** Exit, asking first if a game is in progress. */
function requestExit(): void {
  if (room?.phase !== 'playing') return exitRoom();
  const partnerHere = room.players.some((p) => p.id !== myId);
  confirmExitText.textContent = partnerHere
    ? 'Your partner can keep going without you.'
    : 'Your progress on this puzzle will be lost.';
  confirmExit.hidden = false;
  confirmExitCancel.focus();
}

leaveBtn.addEventListener('click', exitRoom);
winExit.addEventListener('click', exitRoom);
hudExit.addEventListener('click', requestExit);
confirmExitCancel.addEventListener('click', () => (confirmExit.hidden = true));
confirmExitOk.addEventListener('click', exitRoom);
confirmExit.addEventListener('click', (e) => {
  if (e.target === confirmExit) confirmExit.hidden = true;
});
partnerLeftSolo.addEventListener('click', () => (partnerLeft.hidden = true));
partnerLeftExit.addEventListener('click', exitRoom);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  confirmExit.hidden = true;
  partnerLeft.hidden = true;
});

copyBtn.addEventListener('click', async () => {
  if (!room) return;
  const ok = await copyText(shareUrl(room.code));
  copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
  window.setTimeout(() => (copyBtn.textContent = 'Copy link'), 1600);
});
hudCode.addEventListener('click', async () => {
  if (!room) return;
  if (await copyText(shareUrl(room.code))) toast('Share link copied!', 'info');
});

// ---------------------------------------------------------------------------
// Room / game lifecycle
// ---------------------------------------------------------------------------

function enterRoom(playerId: PlayerId, state: RoomState): void {
  myId = playerId;
  room = state;
  shownPoints.clear();
  sessionStorage.setItem(playerKey(state.code), playerId);
  localStorage.setItem(playerKey(state.code), playerId);
  setUrlRoom(state.code);
  roomCodeEl.textContent = state.code;
  hudCode.textContent = state.code;
  shareLink.value = shareUrl(state.code);
  // Only the host (who picked the photo) gets a thumbnail; nobody else sees it before the win.
  const isHost = state.players.some((p) => p.id === playerId && p.isHost);
  if (isHost) waitingThumb.src = state.image;
  else waitingThumb.removeAttribute('src');
  waitingThumb.hidden = !isHost;
  waitingIcon.hidden = isHost;
  confirmExit.hidden = true;
  partnerLeft.hidden = true;
  renderPresence();

  if (state.phase === 'waiting' || !state.game) {
    destroyBoard();
    winOverlay.hidden = true;
    showScreen('waiting');
    return;
  }

  const g = state.game;
  showScreen('game');
  localStartedAt = Math.min(Date.now(), g.startedAt);
  void buildBoard(g.seed, g.pieces, false);
  if (state.phase === 'won') showWin(g.elapsedMs ?? 0, false);
  else winOverlay.hidden = true;
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

function destroyBoard(): void {
  boardToken++;
  board?.destroy();
  board = null;
  pendingBoardEvents = [];
}

async function buildBoard(seed: number, pieces: PieceState[], explode: boolean): Promise<void> {
  if (!room || !myId) return;
  destroyBoard();
  const token = boardToken;
  const r = room;
  const id = myId;
  let image: HTMLImageElement;
  try {
    image = await loadImage(r.image);
  } catch {
    toast("Couldn't load the puzzle image.");
    return;
  }
  if (token !== boardToken) return;
  board = new Board(
    {
      stage,
      socket,
      myId: id,
      colorOf,
      onProgress: (placed, total) => {
        progressText.textContent = `${placed} / ${total}`;
        progressFill.style.width = `${total ? (placed / total) * 100 : 0}%`;
      },
    },
    { image, imageW: r.imageW, imageH: r.imageH, pieceCount: r.pieceCount, seed, pieces },
    explode,
  );
  const queued = pendingBoardEvents;
  pendingBoardEvents = [];
  for (const fn of queued) fn(board);
}

function withBoard(fn: (b: Board) => void): void {
  if (board) fn(board);
  else if (room?.phase !== 'waiting') pendingBoardEvents.push(fn);
}

function showWin(elapsedMs: number, celebrate: boolean): void {
  winTime.textContent = formatTime(elapsedMs);
  timerEl.textContent = formatTime(elapsedMs);
  renderResults();
  if (room) winImage.src = room.image;
  againCount = room?.pieceCount ?? againCount;
  buildPills($('again-difficulty'), againCount, (n) => (againCount = n));
  againBtn.disabled = false;
  againBtn.textContent = 'Play again';
  winOverlay.hidden = false;
  winOverlay.classList.remove('show');
  void winOverlay.offsetWidth;
  winOverlay.classList.add('show');
  if (celebrate) launchConfetti();
}

function launchConfetti(): void {
  confetti.innerHTML = '';
  const colors = ['#ff5a7a', '#3ab0ff', '#ffd34d', '#7cf29a', '#b78bff', '#ff9f43'];
  for (let i = 0; i < 140; i++) {
    const c = document.createElement('i');
    const size = 6 + Math.random() * 8;
    c.style.setProperty('--x', `${Math.random() * 100}vw`);
    c.style.setProperty('--drift', `${(Math.random() - 0.5) * 30}vw`);
    c.style.setProperty('--rot', `${(Math.random() - 0.5) * 1440}deg`);
    c.style.setProperty('--dur', `${2.4 + Math.random() * 2.2}s`);
    c.style.setProperty('--delay', `${Math.random() * 0.9}s`);
    c.style.width = `${size}px`;
    c.style.height = `${size * (0.4 + Math.random() * 0.8)}px`;
    c.style.background = colors[i % colors.length];
    if (Math.random() < 0.3) c.style.borderRadius = '50%';
    confetti.appendChild(c);
  }
  window.setTimeout(() => (confetti.innerHTML = ''), 5500);
}

againBtn.addEventListener('click', () => {
  againBtn.disabled = true;
  againBtn.textContent = 'Shuffling…';
  socket.emit('playAgain', againCount);
});

window.setInterval(() => {
  if (room?.phase === 'playing' && localStartedAt) timerEl.textContent = formatTime(Date.now() - localStartedAt);
}, 500);

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

socket.on('connect', () => {
  setConn('online');
  if (hasConnectedOnce && room) joinRoom(room.code, true);
  hasConnectedOnce = true;
});
socket.on('disconnect', () => setConn('offline'));
socket.io.on('reconnect_attempt', () => {
  if (hasConnectedOnce) setConn('offline');
  else wakeServer();
});

socket.on('playerJoined', (player: PlayerInfo) => {
  if (!room) return;
  const i = room.players.findIndex((p) => p.id === player.id);
  const wasKnown = i >= 0;
  if (wasKnown) room.players[i] = player;
  else room.players.push(player);
  renderPresence();
  if (player.id !== myId && room.phase !== 'waiting') {
    if (!wasKnown) partnerLeft.hidden = true;
    toast(wasKnown ? 'Your partner is back!' : 'A partner joined!', 'info');
  }
});

socket.on('partnerExited', (playerId) => {
  if (!room || playerId === myId) return;
  room.players = room.players.filter((p) => p.id !== playerId);
  renderPresence();
  if (room.phase === 'playing') {
    confirmExit.hidden = true;
    partnerLeft.hidden = false;
    partnerLeftSolo.focus();
  } else {
    toast('Your partner left the puzzle.', 'info');
  }
});

socket.on('playerLeft', (playerId) => {
  if (!room) return;
  const p = room.players.find((pl) => pl.id === playerId);
  if (p) p.connected = false;
  renderPresence();
  if (playerId !== myId) toast('Your partner disconnected. They can rejoin with the same link.', 'info');
});

socket.on('start', (payload) => {
  if (!room || !myId) return;
  room.phase = 'playing';
  room.image = payload.image;
  room.imageW = payload.imageW;
  room.imageH = payload.imageH;
  room.pieceCount = payload.pieceCount;
  room.game = {
    seed: payload.seed,
    cols: payload.cols,
    rows: payload.rows,
    pieces: payload.pieces,
    startedAt: payload.startedAt,
    elapsedMs: null,
    scores: payload.scores,
  };
  shownPoints.clear();
  renderScores();
  localStartedAt = Date.now();
  timerEl.textContent = '00:00';
  winOverlay.hidden = true;
  confetti.innerHTML = '';
  confirmExit.hidden = true;
  winImage.removeAttribute('src');
  showScreen('game');
  void buildBoard(payload.seed, payload.pieces, true);
});

socket.on('pieceGrabbed', (p) => withBoard((b) => b.onPieceGrabbed(p)));
socket.on('grabDenied', (p) => withBoard((b) => b.onGrabDenied(p)));
socket.on('pieceMoved', (p) => withBoard((b) => b.onPieceMoved(p)));
socket.on('dropResult', (p) => {
  if (room?.game && p.scores) {
    room.game.scores = p.scores;
    renderScores();
  }
  withBoard((b) => b.onDropResult(p));
});
socket.on('pieceReleased', (p) => withBoard((b) => b.onPieceReleased(p)));

socket.on('win', ({ elapsedMs, scores }) => {
  if (!room) return;
  room.phase = 'won';
  if (room.game) {
    room.game.elapsedMs = elapsedMs;
    if (scores) room.game.scores = scores;
  }
  renderScores();
  timerEl.textContent = formatTime(elapsedMs);
  window.setTimeout(() => {
    if (room?.phase !== 'won') return;
    board?.settleAll();
    showWin(elapsedMs, true);
  }, 900);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

mountBackground();
showScreen('home');
setConn(socket.connected ? 'online' : 'connecting');
if (socket.connected) hasConnectedOnce = true;
else {
  wakeServer();
  window.setTimeout(() => {
    if (!hasConnectedOnce && !socket.connected) setConn('waking');
  }, 1500);
}

const urlCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (urlCode) {
  codeInput.value = urlCode.slice(0, ROOM_CODE_LENGTH);
  setBusy(false);
  joinRoom(urlCode, true);
}
