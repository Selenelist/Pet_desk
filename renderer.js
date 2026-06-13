const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { ipcRenderer } = require("electron");

// Static configuration
const ACTIONS = ["idle", "walk", "happy", "play", "touch", "eat", "drink", "sleep"];
const DEBUG_LAYOUT = false;
const LOOP_ACTIONS = new Set(["idle", "sleep", "walk"]);
const ONE_SHOT_ACTIONS = new Set(["play", "eat", "drink", "touch", "happy"]);
const RANDOM_ACTIONS = ["idle", "sleep", "happy", "touch"];
const INTERACTIVE_ACTIONS = new Set(["play", "happy", "touch"]);
const VIDEO_EXTENSIONS = [".webm", ".mov", ".mp4"];
const ASSET_ROOT = path.join(__dirname, "assets", "cat");
const EDGE_THRESHOLD = 24;
const DRAG_THRESHOLD = 10;
const EDGE_WALK_COOLDOWN = 1500;
const DEFAULT_CAT_SCALE = 0.55;
const MIN_CAT_SCALE = 0.25;
const MAX_CAT_SCALE = 1.0;
const BASE_STAGE_WIDTH = 520;
const BASE_STAGE_HEIGHT = 620;
const DEFAULT_REST_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const REST_REMINDER_INTERVAL_KEY = "restReminderIntervalMs";
const REST_REMINDER_TEXT = "主人该休息一下啦";
const PET_STATS_KEY = "petStats";
const DEFAULT_PET_STATS = {
  mood: 80,
  fullness: 80,
  hydration: 80,
  energy: 80
};

// DOM references
const stage = document.getElementById("stage");
const petShell = document.getElementById("pet-shell");
const video = document.getElementById("pet-video");
const menu = document.getElementById("pet-menu");
const teaseToy = document.getElementById("tease-toy");
const speechBubble = document.getElementById("speech-bubble");
const bubbleText = speechBubble?.querySelector(".bubble-text");

// Runtime state
const assets = loadAssets();
document.documentElement.classList.toggle("debug-layout", DEBUG_LAYOUT);
let currentAction = null;
let currentPriority = "system";
let isTransitioning = false;
let randomTimer = null;
let isWalking = false;
let walkAnimationId = null;
let walkDirection = null;
let walkTargetX = null;
let walkSpeedPxPerSecond = 45;
let lastWalkTriggerTime = 0;
let dragState = null;
let interactionMode = null;
let interactionTimer = null;
let interactionLoop = null;
let interactionTickInFlight = false;
let isFalling = false;
let isEdgeWalking = false;
let isMenuWalking = false;
let fallAnimationId = null;
let clickTimer = null;
let lastPointerUpAt = 0;
let edgeWalkArmed = false;
let menuWalkArmed = false;
let lastWalkUserGestureAt = 0;
let audioContext = null;
let activeWalkToken = null;
let restReminderTimer = null;
let restReminderIntervalMs = readRestReminderInterval();
let catScale = readSavedCatScale();
let petStats = loadPetStats();
let petStatsDecayTimer = null;

// Asset loading
function loadAssets() {
  const found = {};

  for (const action of ACTIONS) {
    const filePath = findActionVideo(action);

    if (filePath) {
      found[action] = filePath;
    } else {
      console.warn(`[Pet Desk] 缺少可播放素材: ${action}`);
    }
  }

  return found;
}

function findActionVideo(action) {
  const actionDir = path.join(ASSET_ROOT, action);

  if (!fs.existsSync(actionDir)) {
    return null;
  }

  const files = fs
    .readdirSync(actionDir)
    .filter((item) => VIDEO_EXTENSIONS.includes(path.extname(item).toLowerCase()))
    .sort((a, b) => {
      const extDelta = VIDEO_EXTENSIONS.indexOf(path.extname(a).toLowerCase()) - VIDEO_EXTENSIONS.indexOf(path.extname(b).toLowerCase());
      return extDelta || a.localeCompare(b, undefined, { numeric: true });
    });
  const file = files[0];

  if (!file) return null;

  const filePath = path.join(actionDir, file);
  return filePath;
}

function toFileUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Saved preferences
function readSavedCatScale() {
  const savedScale = localStorage.getItem("catScale");
  const value = Number(savedScale);
  if (!Number.isFinite(value) || value > 0.8) return DEFAULT_CAT_SCALE;
  return Math.max(MIN_CAT_SCALE, Math.min(value, MAX_CAT_SCALE));
}

function readRestReminderInterval() {
  const savedInterval = Number(localStorage.getItem(REST_REMINDER_INTERVAL_KEY));
  return Number.isFinite(savedInterval) ? savedInterval : DEFAULT_REST_REMINDER_INTERVAL_MS;
}

// Pet stats
function clampStat(value) {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function loadPetStats() {
  try {
    const savedStats = JSON.parse(localStorage.getItem(PET_STATS_KEY) || "{}");

    return Object.fromEntries(
      Object.entries(DEFAULT_PET_STATS).map(([key, fallback]) => [
        key,
        clampStat(Number.isFinite(Number(savedStats[key])) ? Number(savedStats[key]) : fallback)
      ])
    );
  } catch {
    return { ...DEFAULT_PET_STATS };
  }
}

function savePetStats() {
  localStorage.setItem(PET_STATS_KEY, JSON.stringify(petStats));
}

function broadcastPetStats() {
  ipcRenderer.invoke("pet-stats:update", petStats);
}

function updatePetStats(patch, reason = "update") {
  let changed = false;

  for (const [key, delta] of Object.entries(patch)) {
    if (!(key in DEFAULT_PET_STATS)) continue;

    const nextValue = clampStat((petStats[key] ?? DEFAULT_PET_STATS[key]) + delta);
    if (nextValue !== petStats[key]) {
      petStats[key] = nextValue;
      changed = true;
    }
  }

  if (!changed) return;

  savePetStats();
  broadcastPetStats();
}

function applyActionStats(action) {
  const effects = {
    eat: { fullness: 25, mood: 5 },
    drink: { hydration: 25 },
    play: { mood: 18, energy: -10 },
    touch: { mood: 12 },
    happy: { mood: 14 },
    sleep: { energy: 25, mood: 3 },
    walk: { mood: 8, energy: -15 }
  };

  if (effects[action]) {
    updatePetStats(effects[action], `action:${action}`);
  }
}

function decayPetStats() {
  updatePetStats({
    fullness: -1,
    hydration: -1,
    energy: currentAction === "walk" ? -2 : -1,
    mood: (petStats.fullness < 25 || petStats.hydration < 25 || petStats.energy < 20) ? -1 : 0
  }, "online-decay");
}

function startPetStatsDecayTimer() {
  clearInterval(petStatsDecayTimer);
  petStatsDecayTimer = setInterval(decayPetStats, 60_000);
  savePetStats();
  broadcastPetStats();
}

// Action playback
async function playAction(action, priority = "system", options = {}) {
  if (!assets[action]) {
    console.warn(`[Pet Desk] 动作素材不存在，已跳过: ${action}`);
    return false;
  }

  if (isTransitioning) {
    return false;
  }
  if (currentPriority === "user" && priority !== "user" && currentAction !== "idle") {
    return false;
  }
  if (currentAction === action && currentPriority === priority) {
    return true;
  }

  isTransitioning = true;
  hideMenu();

  video.classList.add("fading");
  await sleep(200);

  currentAction = action;
  currentPriority = priority;
  video.loop = LOOP_ACTIONS.has(action);
  const src = toFileUrl(assets[action]);
  video.src = src;
  video.load();

  try {
    await video.play();
  } catch (error) {
    console.warn(`[Pet Desk] 视频播放失败: ${action}`, error);
  }

  video.classList.remove("fading");
  setTimeout(() => logVideoDisplay(action), 0);
  await sleep(200);
  isTransitioning = false;
  return true;
}

async function logVideoDisplay(action) {
  const boundsInfo = await ipcRenderer.invoke("window:get-bounds");
  const stageRect = stage.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();

  if (DEBUG_LAYOUT) {
    console.log("VIDEO DISPLAY", {
      action,
      windowWidth: boundsInfo?.window?.width,
      windowHeight: boundsInfo?.window?.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      stageRect: {
        x: stageRect.x,
        y: stageRect.y,
        width: stageRect.width,
        height: stageRect.height
      },
      videoRect: {
        x: videoRect.x,
        y: videoRect.y,
        width: videoRect.width,
        height: videoRect.height
      }
    });
  }
}

// Interaction mode
async function startInteractionMode(mode) {
  if (!INTERACTIVE_ACTIONS.has(mode)) return;

  if (interactionMode) {
    const previousMode = interactionMode;
    await stopInteractionMode(true);
    if (previousMode === mode) {
      return;
    }
  }

  const started = await playAction(mode, "user");
  if (!started) return;

  interactionMode = mode;
  currentPriority = "user";
  teaseToy.classList.remove("hidden");
  updateInteractionFacing(0);

  interactionTimer = setTimeout(() => {
    stopInteractionMode(true);
  }, randomInt(8_000, 12_000));

  interactionLoop = setInterval(updateInteraction, 70);
  updateInteraction();
}

async function stopInteractionMode(returnToIdle = false) {
  if (!interactionMode) return;

  interactionMode = null;
  clearTimeout(interactionTimer);
  clearInterval(interactionLoop);
  interactionTimer = null;
  interactionLoop = null;
  interactionTickInFlight = false;
  teaseToy.classList.add("hidden");
  petShell.classList.remove("facing-right");
  currentPriority = "system";

  if (returnToIdle) {
    await playAction("idle", "system");
  }
}

async function updateInteraction() {
  if (!interactionMode || interactionTickInFlight || dragState || isFalling) return;

  interactionTickInFlight = true;

  try {
    const [cursor, boundsInfo] = await Promise.all([
      ipcRenderer.invoke("cursor:get-position"),
      ipcRenderer.invoke("window:get-bounds")
    ]);

    if (!boundsInfo) return;

    const bounds = boundsInfo.window;
    const localX = cursor.x - bounds.x;
    const localY = cursor.y - bounds.y;
    const clampedX = Math.max(18, Math.min(localX, bounds.width - 18));
    const clampedY = Math.max(18, Math.min(localY, bounds.height - 18));

    teaseToy.style.left = `${clampedX}px`;
    teaseToy.style.top = `${clampedY}px`;

    const dx = cursor.x - (bounds.x + bounds.width / 2);
    updateInteractionFacing(dx);
  } finally {
    interactionTickInFlight = false;
  }
}

function updateInteractionFacing(dx) {
  petShell.classList.toggle("facing-right", dx > 0);
}

// Walking
async function prepareWalk(direction, reason) {
  if (isWalking || dragState) {
    return false;
  }

  walkDirection = direction;
  updateWalkFacing();
  const started = await playAction("walk", "user", { keepWalkState: true });
  if (!started) {
    walkDirection = null;
    updateWalkFacing();
    return false;
  }

  currentPriority = "user";
  video.loop = true;
  isWalking = true;
  applyActionStats("walk");
  return true;
}

function updateWalkFacing() {
  petShell.classList.toggle("facing-right", walkDirection === "right");
}

function scheduleRandomAction() {
  clearTimeout(randomTimer);
  const delay = randomInt(20_000, 60_000);

  randomTimer = setTimeout(async () => {
    if (currentPriority !== "user" && !dragState && !interactionMode && !isFalling && !isEdgeWalking && !isMenuWalking) {
      const candidates = RANDOM_ACTIONS.filter((action) => assets[action]);
      const nextAction = candidates[randomInt(0, candidates.length - 1)];
      if (nextAction) {
        await playAction(nextAction, "system");
      }
    }

    scheduleRandomAction();
  }, delay);
}

// Rest reminder
function showSpeechBubble(text) {
  if (!speechBubble || !bubbleText) return;

  bubbleText.textContent = text;
  speechBubble.classList.remove("hidden");
}

function playReminderMeow() {
  try {
    audioContext = audioContext || new AudioContext();

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const overtone = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const overtoneGain = audioContext.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(820, now);
    oscillator.frequency.exponentialRampToValueAtTime(520, now + 0.22);
    oscillator.frequency.exponentialRampToValueAtTime(690, now + 0.54);
    oscillator.frequency.exponentialRampToValueAtTime(430, now + 0.82);

    overtone.type = "sine";
    overtone.frequency.setValueAtTime(1320, now);
    overtone.frequency.exponentialRampToValueAtTime(900, now + 0.2);
    overtone.frequency.exponentialRampToValueAtTime(1120, now + 0.5);
    overtone.frequency.exponentialRampToValueAtTime(760, now + 0.82);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.28, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.38);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);

    overtoneGain.gain.setValueAtTime(0.0001, now);
    overtoneGain.gain.exponentialRampToValueAtTime(0.08, now + 0.04);
    overtoneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.76);

    oscillator.connect(gain);
    overtone.connect(overtoneGain);
    gain.connect(audioContext.destination);
    overtoneGain.connect(audioContext.destination);
    oscillator.start(now);
    overtone.start(now + 0.02);
    oscillator.stop(now + 1.0);
    overtone.stop(now + 0.82);
  } catch (error) {
    console.warn("[Pet Desk] 休息提醒猫叫播放失败", error);
  }
}

function hideSpeechBubble() {
  if (!speechBubble) return;

  speechBubble.classList.add("hidden");
}

function showRestReminder() {
  showSpeechBubble(REST_REMINDER_TEXT);
  playReminderMeow();
}

function applyRestReminderInterval(intervalMs) {
  restReminderIntervalMs = Math.max(0, Number(intervalMs) || 0);
  localStorage.setItem(REST_REMINDER_INTERVAL_KEY, String(restReminderIntervalMs));
  startRestReminderTimer();
}

function startRestReminderTimer() {
  clearInterval(restReminderTimer);
  restReminderTimer = null;

  if (restReminderIntervalMs <= 0) {
    hideSpeechBubble();
    return;
  }

  restReminderTimer = setInterval(showRestReminder, restReminderIntervalMs);
}

// State cleanup helpers
async function stopActiveState(reason = "clicked", returnToIdle = true) {
  await stopInteractionMode(false);
  stopWalk(reason);
  stopFall(reason);
  currentPriority = "system";

  if (returnToIdle && currentAction !== "idle") {
    await playAction("idle", "system");
  } else if (returnToIdle) {
    video.classList.add("clicked");
    setTimeout(() => video.classList.remove("clicked"), 160);
  }
}

function stopWalk(reason = "stopped") {
  if (DEBUG_LAYOUT) {
    console.log("WALK STOP", { reason });
  }
  if (activeWalkToken) {
    ipcRenderer.invoke("window:walk-end", activeWalkToken);
    activeWalkToken = null;
  }

  if (walkAnimationId) {
    cancelAnimationFrame(walkAnimationId);
    walkAnimationId = null;
  }

  isWalking = false;
  isEdgeWalking = false;
  isMenuWalking = false;
  walkDirection = null;
  walkTargetX = null;
  petShell.classList.remove("facing-right");
}

function stopFall(reason = "stopped") {
  if (!isFalling && !fallAnimationId) return;

  if (fallAnimationId) {
    cancelAnimationFrame(fallAnimationId);
    fallAnimationId = null;
  }

  isFalling = false;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function easeOutBounce(t) {
  const n1 = 7.5625;
  const d1 = 2.75;

  if (t < 1 / d1) {
    return n1 * t * t;
  }

  if (t < 2 / d1) {
    const adjusted = t - 1.5 / d1;
    return n1 * adjusted * adjusted + 0.75;
  }

  if (t < 2.5 / d1) {
    const adjusted = t - 2.25 / d1;
    return n1 * adjusted * adjusted + 0.9375;
  }

  const adjusted = t - 2.625 / d1;
  return n1 * adjusted * adjusted + 0.984375;
}

function getVisualBounds(boundsInfo) {
  const bounds = boundsInfo.window;
  const visualWidth = BASE_STAGE_WIDTH * catScale;
  const visualHeight = BASE_STAGE_HEIGHT * catScale;
  const horizontalOverhang = Math.max(0, (bounds.width - visualWidth) / 2);
  const verticalOverhang = Math.max(0, (bounds.height - visualHeight) / 2);

  return {
    visualWidth,
    visualHeight,
    horizontalOverhang,
    verticalOverhang,
    visualLeft: bounds.x + horizontalOverhang,
    visualRight: bounds.x + horizontalOverhang + visualWidth,
    visualTop: bounds.y + verticalOverhang,
    visualBottom: bounds.y + verticalOverhang + visualHeight
  };
}

// Drag release behaviors
async function handleDragRelease(dragDistance) {
  const boundsInfo = await ipcRenderer.invoke("window:get-bounds");
  if (!boundsInfo) return;

  const { window: bounds, display, displayBounds } = boundsInfo;
  const edgeBounds = displayBounds || display;
  const visualBounds = getVisualBounds(boundsInfo);

  // 如果拖动距离太小，不处理
  if (dragDistance < DRAG_THRESHOLD) {
    edgeWalkArmed = false;
    
    // 如果是睡眠状态，保持睡眠
    if (currentAction === "sleep") {
      return;
    }
    
    await stopActiveState("dragEnd none", true);
    return;
  }

  // 检查是否触到右边边界
  // 使用窗口的实际右边缘来检测，而不是视觉边界
  // 增加容差让检测更容易触发
  const windowRight = bounds.x + bounds.width;
  const rightEdge = edgeBounds.x + edgeBounds.width - EDGE_THRESHOLD - 50;
  
  if (windowRight >= rightEdge) {
    // 如果是睡眠状态，保持睡眠，不触发走路
    if (currentAction === "sleep") {
      edgeWalkArmed = false;
      return;
    }
    
    edgeWalkArmed = false;
    
    // 重新设置用户手势时间，确保走路不会因为超时被忽略
    lastWalkUserGestureAt = performance.now();
    await startEdgeWalkToLeft(boundsInfo);
    return;
  }

  // 检查是否触到左边边界
  if (visualBounds.visualLeft <= edgeBounds.x + EDGE_THRESHOLD) {
    // 如果是睡眠状态，保持睡眠
    if (currentAction === "sleep") {
      edgeWalkArmed = false;
      return;
    }
    
    edgeWalkArmed = false;
    lastWalkUserGestureAt = performance.now();
    await startEdgeWalkToRight(boundsInfo);
    return;
  }

  edgeWalkArmed = false;
  
  // 如果是睡眠状态，保持睡眠
  if (currentAction === "sleep") {
    return;
  }
  
  await stopActiveState("dragEnd none", true);
}

// 走路到左边边缘的函数
async function startEdgeWalkToLeft(boundsInfo) {
  // 使用和菜单散步相同的逻辑
  if (isWalking || isFalling || dragState) {
    return;
  }

  stopWalk("new edge walk");

  const pos = await ipcRenderer.invoke("get-pet-window-position");
  const currentX = pos?.x ?? boundsInfo?.window?.x ?? 0;
  const currentY = pos?.y ?? boundsInfo?.window?.y ?? 0;
  const display = boundsInfo?.displayBounds || boundsInfo?.display || { x: 0 };
  const targetX = display.x;
  const started = await prepareWalk("left", "EDGE WALK PREPARED");

  if (!started) return;

  isEdgeWalking = true;
  walkTargetX = targetX;
  activeWalkToken = `edge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await ipcRenderer.invoke("window:walk-begin", activeWalkToken);

  let lastWalkTime = performance.now();
  let edgeWalkX = currentX;

  const edgeWalkTick = async (now) => {
    if (!isWalking || walkDirection !== "left") return;

    const dt = Math.min((now - lastWalkTime) / 1000, 0.05);
    lastWalkTime = now;

    const latestPosition = await ipcRenderer.invoke("get-pet-window-position");
    const latestY = latestPosition?.y ?? currentY;
    edgeWalkX -= walkSpeedPxPerSecond * dt;
    let nextX = edgeWalkX;
    const plannedReachedLeftEdge = nextX <= targetX;

    if (plannedReachedLeftEdge) {
      nextX = targetX;
      edgeWalkX = targetX;
    }

    await ipcRenderer.invoke("set-pet-window-position", Math.round(nextX), Math.round(latestY));
    const after = await ipcRenderer.invoke("get-pet-window-position");

    const actualReachedLeftEdge = (after?.x ?? nextX) <= targetX;

    if (actualReachedLeftEdge) {
      stopWalk("reached left edge");
      currentPriority = "system";
      await playAction("idle", "system");
      return;
    }

    walkAnimationId = requestAnimationFrame(edgeWalkTick);
  };

  walkAnimationId = requestAnimationFrame(edgeWalkTick);
}

async function startEdgeWalkToRight(boundsInfo) {
  if (isWalking || isFalling || dragState) {
    return;
  }

  stopWalk("new edge walk");

  const pos = await ipcRenderer.invoke("get-pet-window-position");
  const currentX = Number(pos?.x ?? boundsInfo?.window?.x ?? 0);
  const currentY = Number(pos?.y ?? boundsInfo?.window?.y ?? 0);
  const display = boundsInfo?.displayBounds || boundsInfo?.display || { x: 0, width: 0 };
  const displayX = Number(display.x ?? 0);
  const displayWidth = Number(display.width ?? 0);
  const windowWidth = Number(boundsInfo?.window?.width ?? 0);
  const targetX = displayX + displayWidth - windowWidth;

  if (![currentX, currentY, targetX].every(Number.isFinite)) {
    console.warn("edge walk right ignored invalid bounds", { currentX, currentY, targetX, display, window: boundsInfo?.window });
    return;
  }

  const started = await prepareWalk("right", "EDGE WALK PREPARED");

  if (!started) return;

  isEdgeWalking = true;
  walkTargetX = targetX;
  activeWalkToken = `edge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await ipcRenderer.invoke("window:walk-begin", activeWalkToken);

  let lastWalkTime = performance.now();
  let edgeWalkX = currentX;

  const edgeWalkTick = async (now) => {
    if (!isWalking || walkDirection !== "right") return;

    const dt = Math.min((now - lastWalkTime) / 1000, 0.05);
    lastWalkTime = now;

    const latestPosition = await ipcRenderer.invoke("get-pet-window-position");
    const latestY = latestPosition?.y ?? currentY;
    edgeWalkX += walkSpeedPxPerSecond * dt;
    let nextX = edgeWalkX;
    const plannedReachedRightEdge = nextX >= targetX;

    if (plannedReachedRightEdge) {
      nextX = targetX;
      edgeWalkX = targetX;
    }

    await ipcRenderer.invoke("set-pet-window-position", Math.round(nextX), Math.round(latestY));
    const after = await ipcRenderer.invoke("get-pet-window-position");

    const actualReachedRightEdge = (after?.x ?? nextX) >= targetX;

    if (plannedReachedRightEdge || actualReachedRightEdge) {
      stopWalk("reached right edge");
      currentPriority = "system";
      await playAction("idle", "system");
      return;
    }

    walkAnimationId = requestAnimationFrame(edgeWalkTick);
  };

  walkAnimationId = requestAnimationFrame(edgeWalkTick);
}

async function startFall(boundsInfo) {
  if (isFalling || isEdgeWalking) return;

  isFalling = true;
  currentPriority = "user";
  await stopInteractionMode(false);
  stopWalk("fall");
  hideMenu();

  const startBounds = boundsInfo.window;
  const display = await ipcRenderer.invoke("screen:get-primary-work-area");
  const startY = startBounds.y;
  const targetY = Math.max(display.y, display.y + display.height - startBounds.height - 18);
  const duration = 900;
  const startedAt = performance.now();

  await new Promise((resolve) => {
    const step = async (now) => {
      if (!isFalling) {
        resolve();
        return;
      }

      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = easeOutBounce(progress);
      const y = startY + (targetY - startY) * eased;

      await ipcRenderer.invoke("window:set-position-soft", {
        x: startBounds.x,
        y,
        catScale
      });

      if (progress < 1) {
        fallAnimationId = requestAnimationFrame(step);
      } else {
        resolve();
      }
    };

    fallAnimationId = requestAnimationFrame(step);
  });

  fallAnimationId = null;
  if (!isFalling) return;

  isFalling = false;
  currentPriority = "system";
  await playAction("idle", "system");
}

async function startEdgeWalk(boundsInfo, direction) {
  if (!edgeWalkArmed) {
    return;
  }
  edgeWalkArmed = false;

  if (isWalking || isFalling || dragState) {
    return;
  }

  const now = Date.now();
  if (now - lastWalkTriggerTime < EDGE_WALK_COOLDOWN) {
    return;
  }

  lastWalkTriggerTime = now;
  await stopInteractionMode(false);
  stopWalk("edgeWalk");
  hideMenu();

  const display = boundsInfo.displayBounds || boundsInfo.display;
  const visualBounds = getVisualBounds(boundsInfo);
  const leftTargetX = display.x + 5 - visualBounds.horizontalOverhang;
  const rightTargetX = display.x + display.width - visualBounds.visualWidth - visualBounds.horizontalOverhang - 5;
  const targetX = direction === "right"
    ? rightTargetX
    : leftTargetX;
  const normalizedX = direction === "right"
    ? leftTargetX
    : rightTargetX;
  const normalizedBounds = await ipcRenderer.invoke("window:set-position-soft", {
    x: normalizedX,
    y: boundsInfo.window.y,
    catScale
  }) || { ...boundsInfo.window, x: normalizedX };

  isEdgeWalking = true;
  await startWalkMotion({
    direction,
    targetX,
    y: normalizedBounds.y,
    mode: "edge",
    stopReason: direction === "right" ? "reached right edge" : "reached left edge"
  });
}

async function startMenuWalk() {
  menuWalkArmed = false;
  if (dragState) {
    return;
  }

  stopWalk("new menu walk");

  const boundsInfo = await ipcRenderer.invoke("window:get-bounds");
  const pos = await ipcRenderer.invoke("get-pet-window-position");
  const currentX = pos?.x ?? boundsInfo?.window?.x ?? 0;
  const currentY = pos?.y ?? boundsInfo?.window?.y ?? 0;
  const display = boundsInfo?.displayBounds || boundsInfo?.display || { x: 0 };
  const targetX = display.x;
  const started = await prepareWalk("left", "MENU WALK PREPARED");

  if (!started) return;

  isMenuWalking = true;
  walkTargetX = targetX;
  activeWalkToken = `menu-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await ipcRenderer.invoke("window:walk-begin", activeWalkToken);

  let lastWalkTime = performance.now();
  let menuWalkX = currentX;

  const menuWalkTick = async (now) => {
    if (!isWalking || walkDirection !== "left") return;

    const dt = Math.min((now - lastWalkTime) / 1000, 0.05);
    lastWalkTime = now;

    const latestPosition = await ipcRenderer.invoke("get-pet-window-position");
    const latestY = latestPosition?.y ?? currentY;
    menuWalkX -= walkSpeedPxPerSecond * dt;
    let nextX = menuWalkX;
    const plannedReachedLeftEdge = nextX <= targetX;

    if (plannedReachedLeftEdge) {
      nextX = targetX;
      menuWalkX = targetX;
    }

    await ipcRenderer.invoke("set-pet-window-position", Math.round(nextX), Math.round(latestY));
    const after = await ipcRenderer.invoke("get-pet-window-position");

    const actualReachedLeftEdge = (after?.x ?? nextX) <= targetX;

    if (plannedReachedLeftEdge || actualReachedLeftEdge) {
      stopWalk("reached left edge");
      currentPriority = "system";
      await playAction("idle", "system");
      return;
    }

    walkAnimationId = requestAnimationFrame(menuWalkTick);
  };

  walkAnimationId = requestAnimationFrame(menuWalkTick);
}

async function startWalkMotion({ direction, targetX, y, mode, stopReason = "walk complete", durationMs = null, bounce = false, leftX = null, rightX = null }) {
  if (mode !== "edge" && mode !== "menu") {
    return;
  }
  
  const timeSinceGesture = performance.now() - lastWalkUserGestureAt;
  
  if (timeSinceGesture > 1000) {
    return;
  }

  const prepared = await prepareWalk(direction, `startWalk mode=${mode}`);
  if (!prepared) return;

  activeWalkToken = `${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await ipcRenderer.invoke("window:walk-begin", activeWalkToken);
  isEdgeWalking = mode === "edge";
  isMenuWalking = mode === "menu";
  walkTargetX = targetX;

  let lastTime = performance.now();
  const endAt = durationMs ? lastTime + durationMs : null;
  const walkTick = async (now) => {
    if (!isWalking) return;

    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const boundsInfo = await ipcRenderer.invoke("window:get-bounds");
    const currentX = boundsInfo?.window?.x ?? 0;
    const currentY = boundsInfo?.window?.y ?? y;
    const directionSign = walkDirection === "right" ? 1 : -1;
    const alreadyReachedTarget = !bounce && (
      (directionSign > 0 && currentX >= walkTargetX) ||
      (directionSign < 0 && currentX <= walkTargetX)
    );

    if (alreadyReachedTarget) {
      stopWalk(stopReason);
      currentPriority = "system";
      await playAction("idle", "system");
      return;
    }

    let nextX = currentX + directionSign * walkSpeedPxPerSecond * dt;

    if (bounce && leftX !== null && rightX !== null) {
      if (nextX <= leftX) {
        nextX = leftX;
        walkDirection = "right";
        walkTargetX = rightX;
      } else if (nextX >= rightX) {
        nextX = rightX;
        walkDirection = "left";
        walkTargetX = leftX;
      }
      updateWalkFacing();
    } else if ((directionSign > 0 && nextX >= walkTargetX) || (directionSign < 0 && nextX <= walkTargetX)) {
      nextX = walkTargetX;
    }

    const reachedTarget = !bounce && ((directionSign > 0 && nextX >= walkTargetX) || (directionSign < 0 && nextX <= walkTargetX));
    const reachedDuration = endAt && now >= endAt;

    await ipcRenderer.invoke("window:set-position-for-walk", {
      x: nextX,
      y: currentY,
      mode,
      token: activeWalkToken,
      catScale
    });

    if (reachedTarget || reachedDuration) {
      stopWalk(stopReason);
      currentPriority = "system";
      await playAction("idle", "system");
      return;
    }

    walkAnimationId = requestAnimationFrame(walkTick);
  };

  walkAnimationId = requestAnimationFrame(walkTick);
}

// Menu and settings window
async function showMenu() {
  const menuPadding = 16;
  const beforeCatScale = catScale;
  const petStageTransformBefore = getComputedStyle(petShell).transform;
  const boundsBefore = await ipcRenderer.invoke("window:get-bounds");
  const windowBoundsBefore = boundsBefore?.window;
  const petRectBefore = petShell.getBoundingClientRect();
  const petScreenLeft = (windowBoundsBefore?.x ?? 0) + petRectBefore.left;
  const petScreenTop = (windowBoundsBefore?.y ?? 0) + petRectBefore.top;

  const expandedInfo = await ipcRenderer.invoke("window:expand-for-menu", catScale);
  const expandedBounds = expandedInfo?.window || expandedInfo;
  petShell.style.left = "";
  petShell.style.top = "";
  let petRect = petShell.getBoundingClientRect();
  petShell.style.left = `${petScreenLeft - expandedBounds.x - petRect.left}px`;
  petShell.style.top = `${petScreenTop - expandedBounds.y - petRect.top}px`;
  menu.classList.remove("hidden");
  const windowWidth = expandedBounds?.width ?? window.innerWidth;
  const windowHeight = expandedBounds?.height ?? window.innerHeight;
  petRect = petShell.getBoundingClientRect();
  const menuBounds = menu.getBoundingClientRect();
  const menuWidth = menuBounds.width;
  const menuHeight = menuBounds.height;
  const candidates = [
    {
      placement: "right",
      left: petRect.right + menuPadding,
      top: petRect.top + Math.max(0, (petRect.height - menuHeight) / 2)
    },
    {
      placement: "left",
      left: petRect.left - menuWidth - menuPadding,
      top: petRect.top + Math.max(0, (petRect.height - menuHeight) / 2)
    },
    {
      placement: "top",
      left: petRect.left + Math.max(0, (petRect.width - menuWidth) / 2),
      top: petRect.top - menuHeight - menuPadding
    },
    {
      placement: "bottom",
      left: petRect.left + Math.max(0, (petRect.width - menuWidth) / 2),
      top: petRect.bottom + menuPadding
    }
  ];
  const fits = (candidate) =>
    candidate.left >= 8 &&
    candidate.top >= 8 &&
    candidate.left + menuWidth <= windowWidth - 8 &&
    candidate.top + menuHeight <= windowHeight - 8;
  const selected = candidates.find(fits) || candidates[0];
  const left = Math.max(8, Math.min(selected.left, windowWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(selected.top, windowHeight - menuHeight - 8));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const nextMenuRect = {
    left,
    top,
    right: left + menuWidth,
    bottom: top + menuHeight,
    width: menuWidth,
    height: menuHeight
  };
  const petDebugRect = {
    left: petRect.left,
    top: petRect.top,
    right: petRect.right,
    bottom: petRect.bottom,
    width: petRect.width,
    height: petRect.height
  };
  const overlapsPet =
    nextMenuRect.left < petDebugRect.right &&
    nextMenuRect.right > petDebugRect.left &&
    nextMenuRect.top < petDebugRect.bottom &&
    nextMenuRect.bottom > petDebugRect.top;
  const menuFullyVisibleInWindow =
    nextMenuRect.left >= 0 &&
    nextMenuRect.top >= 0 &&
    nextMenuRect.right <= windowWidth &&
    nextMenuRect.bottom <= windowHeight;
  const screenBounds = expandedInfo?.screenBounds;
  const menuScreenRect = {
    left: expandedBounds.x + nextMenuRect.left,
    top: expandedBounds.y + nextMenuRect.top,
    right: expandedBounds.x + nextMenuRect.right,
    bottom: expandedBounds.y + nextMenuRect.bottom,
    width: nextMenuRect.width,
    height: nextMenuRect.height
  };
  const menuFullyVisibleOnScreen = screenBounds
    ? menuScreenRect.left >= screenBounds.x &&
      menuScreenRect.top >= screenBounds.y &&
      menuScreenRect.right <= screenBounds.x + screenBounds.width &&
      menuScreenRect.bottom <= screenBounds.y + screenBounds.height
    : true;

  if (DEBUG_LAYOUT) {
    console.log("MENU POSITION DEBUG", {
      catScale,
      petRect: petDebugRect,
      menuItemsRect: nextMenuRect,
      placement: selected.placement,
      screenBounds,
      windowBounds: expandedBounds,
      menuFullyVisible: menuFullyVisibleInWindow && menuFullyVisibleOnScreen,
      overlapsPet
    });
    console.log("MENU OPEN SCALE CHECK", {
      beforeCatScale,
      afterCatScale: catScale,
      petStageTransform: getComputedStyle(petShell).transform,
      windowBoundsBefore,
      windowBoundsAfter: expandedBounds
    });
  }
}

async function hideMenu() {
  const wasOpen = !menu.classList.contains("hidden");
  menu.classList.add("hidden");

  if (wasOpen) {
    await ipcRenderer.invoke("window:restore-after-menu", catScale);
  }
  petShell.style.left = "";
  petShell.style.top = "";
}

function showSettingsPanel() {
  hideMenu();
  ipcRenderer.invoke("settings:open");
}

async function applyCatScale(nextScale, source = "slider", notifyMain = true) {
  catScale = Math.max(MIN_CAT_SCALE, Math.min(Number(nextScale) || DEFAULT_CAT_SCALE, MAX_CAT_SCALE));
  localStorage.setItem("catScale", String(catScale));
  const bubbleScale = Math.min(1.7, Math.max(1, catScale / DEFAULT_CAT_SCALE));
  stage.style.setProperty("--cat-scale", String(catScale));
  stage.style.setProperty("--bubble-scale", String(bubbleScale));
  document.body.style.setProperty("--cat-scale", String(catScale));
  document.body.style.setProperty("--bubble-scale", String(bubbleScale));
  if (notifyMain) {
    await ipcRenderer.invoke("resize-pet-window", { catScale, source });
  }
}

// Debug helpers
async function logLayoutDebug(label = "layout debug") {
  const boundsInfo = await ipcRenderer.invoke("window:get-bounds");
  if (!boundsInfo) return;

  const stageRect = stage.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  const constraints = boundsInfo.constraints || {};

  console.log(label, {
    windowX: boundsInfo.window.x,
    windowY: boundsInfo.window.y,
    windowWidth: boundsInfo.window.width,
    windowHeight: boundsInfo.window.height,
    videoWidth: videoRect.width,
    videoHeight: videoRect.height,
    stageWidth: stageRect.width,
    stageHeight: stageRect.height,
    displayBounds: boundsInfo.displayBounds,
    workArea: boundsInfo.display,
    minY: constraints.minY,
    maxY: constraints.maxY
  });
}

async function moveToTopTest() {
  const bounds = await ipcRenderer.invoke("window:move-to-absolute-top-test");
  console.log("moveToAbsoluteTopTest", bounds);
  await logLayoutDebug("moveToAbsoluteTopTest layout debug");
}

// Pointer and click handling
function scheduleSingleClick() {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(async () => {
    clickTimer = null;
    hideSpeechBubble();
    hideMenu();
    
    // 如果正在走路，停止走路
    if (isWalking) {
      stopWalk("clicked");
    }
    
    // 如果正在睡眠，唤醒猫猫
    if (currentAction === "sleep") {
      currentPriority = "system";
      await playAction("idle", "system");
      return;
    }
    
    await stopActiveState("clicked", true);
  }, 220);
}

async function handleDoubleClick() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }

  hideMenu();
  await stopActiveState("menu", true);
  showMenu();
}

// Event bindings
petShell.addEventListener("pointerdown", async (event) => {
  if (event.button !== 0) return;

  hideMenu();
  petShell.setPointerCapture(event.pointerId);

  const boundsInfo = await ipcRenderer.invoke("window:get-bounds");
  dragState = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startWindowX: boundsInfo.window.x,
    startWindowY: boundsInfo.window.y,
    moved: false
  };
});

petShell.addEventListener("pointermove", async (event) => {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (isFalling) return;

  const dx = event.screenX - dragState.startScreenX;
  const dy = event.screenY - dragState.startScreenY;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
    dragState.moved = true;
  }

  if (dragState.moved) {
    await ipcRenderer.invoke("window:drag-to", {
      x: dragState.startWindowX + dx,
      y: dragState.startWindowY + dy,
      catScale
    });
  }
});

petShell.addEventListener("pointerup", (event) => {
  if (!dragState || dragState.pointerId !== event.pointerId) return;

  const dx = event.screenX - dragState.startScreenX;
  const dy = event.screenY - dragState.startScreenY;
  const dragDistance = Math.hypot(dx, dy);
  const wasDrag = dragState.moved && dragDistance >= DRAG_THRESHOLD;
  dragState = null;

  if (wasDrag) {
    if (event.isTrusted) {
      lastWalkUserGestureAt = performance.now();
      edgeWalkArmed = true;
    }
    handleDragRelease(dragDistance);
    return;
  }

  const now = performance.now();
  const isDoubleClick = clickTimer || now - lastPointerUpAt < 280;
  lastPointerUpAt = now;

  if (isDoubleClick) {
    handleDoubleClick();
  } else {
    scheduleSingleClick();
  }
});

stage.addEventListener("pointerdown", (event) => {
  if (!menu.contains(event.target) && event.target !== video && event.target !== petShell) {
    hideMenu();
  }
});

if (speechBubble) {
  speechBubble.addEventListener("click", (event) => {
    event.stopPropagation();
    hideSpeechBubble();
  });
}

menu.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  await hideMenu();

  if (action === "quit") {
    await stopActiveState("menu/actionChanged", false);
    await ipcRenderer.invoke("app:quit");
    return;
  }

  if (action === "settings") {
    await stopActiveState("settings", false);
    showSettingsPanel();
    return;
  }

  await stopActiveState("menu/actionChanged", false);

  if (action === "walk") {
    if (event.isTrusted) {
      lastWalkUserGestureAt = performance.now();
      menuWalkArmed = true;
    }
    await startMenuWalk();
    return;
  }

  applyActionStats(action);

  if (INTERACTIVE_ACTIONS.has(action)) {
    await startInteractionMode(action);
    return;
  }

  await playAction(action, "user");
});

video.addEventListener("ended", async () => {
  if (currentAction === "walk" || isEdgeWalking || isMenuWalking) {
    video.currentTime = 0;
    await video.play();
    return;
  }

  if (interactionMode && currentAction === interactionMode) {
    video.currentTime = 0;
    await video.play();
    return;
  }

  if (ONE_SHOT_ACTIONS.has(currentAction)) {
    currentPriority = "system";
    await playAction("idle", "system");
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideMenu();
  }

  if (event.key.toLowerCase() === "t") {
    moveToTopTest();
  }
});

ipcRenderer.on("pet:show-idle", () => {
  stopInteractionMode(false);
  currentPriority = "system";
  playAction("idle", "system");
});

ipcRenderer.on("pet:set-scale", (_event, payload) => {
  applyCatScale(payload?.scale, payload?.source || "slider", false);
});

ipcRenderer.on("pet:set-rest-reminder-interval", (_event, intervalMs) => {
  applyRestReminderInterval(intervalMs);
});

// App startup
document.addEventListener("DOMContentLoaded", async () => {
  if (!video) {
    console.error("video element not found!");
    return;
  }
  
  catScale = DEFAULT_CAT_SCALE;
  
  await playAction("idle", "system");
  scheduleRandomAction();
  startRestReminderTimer();
  startPetStatsDecayTimer();
  applyCatScale(catScale, "default");
});

if (DEBUG_LAYOUT) {
  setTimeout(() => {
    logLayoutDebug("startup layout debug");
  }, 2000);
}
