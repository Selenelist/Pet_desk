const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");

// Window sizing configuration
const DEBUG_LAYOUT = false;
const BASE_STAGE_WIDTH = 520;
const BASE_STAGE_HEIGHT = 620;
const DEFAULT_CAT_SCALE = 0.55;
const SAFE_PADDING_X = 80;
const SAFE_PADDING_Y = 80;
const LARGE_SCALE_PADDING_THRESHOLD = 0.7;
const LARGE_SCALE_EXTRA_PADDING = 220;
const MENU_WINDOW_PADDING_X = 260;
const MENU_WINDOW_PADDING_Y = 340;
const WINDOW_WIDTH = Math.ceil(BASE_STAGE_WIDTH * DEFAULT_CAT_SCALE + SAFE_PADDING_X);
const WINDOW_HEIGHT = Math.ceil(BASE_STAGE_HEIGHT * DEFAULT_CAT_SCALE + SAFE_PADDING_Y);

// Main-process state
let mainWindow;
let settingsWindow;
let menuRestoreBounds = null;
let activeWalkToken = null;
let latestPetStats = {
  mood: 80,
  fullness: 80,
  hydration: 80,
  energy: 80
};

// Pet window sizing and movement
function getPetWindowSize(scale) {
  const catScale = Math.max(0.25, Math.min(Number(scale) || DEFAULT_CAT_SCALE, 1));
  const visualWidth = BASE_STAGE_WIDTH * catScale;
  const visualHeight = BASE_STAGE_HEIGHT * catScale;
  const extraPadding = catScale > LARGE_SCALE_PADDING_THRESHOLD ? LARGE_SCALE_EXTRA_PADDING : 0;
  const scaledWindowWidth = visualWidth + SAFE_PADDING_X + extraPadding;
  const scaledWindowHeight = visualHeight + SAFE_PADDING_Y + extraPadding;
  const largeScaleWindowWidth = BASE_STAGE_WIDTH + SAFE_PADDING_X + extraPadding;
  const largeScaleWindowHeight = BASE_STAGE_HEIGHT + SAFE_PADDING_Y + extraPadding;
  const windowWidth = Math.ceil(catScale > LARGE_SCALE_PADDING_THRESHOLD
    ? Math.max(scaledWindowWidth, largeScaleWindowWidth)
    : scaledWindowWidth);
  const windowHeight = Math.ceil(catScale > LARGE_SCALE_PADDING_THRESHOLD
    ? Math.max(scaledWindowHeight, largeScaleWindowHeight)
    : scaledWindowHeight);

  return {
    catScale,
    visualWidth,
    visualHeight,
    extraPadding,
    windowWidth,
    windowHeight
  };
}

function resizePetWindow(scale) {
  if (!mainWindow) return null;

  const size = getPetWindowSize(scale);
  const display = screen.getPrimaryDisplay();
  const screenBounds = display.bounds;
  const positionX = Math.round(screenBounds.x + (screenBounds.width - size.windowWidth) / 2);
  const positionY = Math.round(screenBounds.y + (screenBounds.height - size.windowHeight) / 2);

  mainWindow.setBounds({
    x: positionX,
    y: positionY,
    width: size.windowWidth,
    height: size.windowHeight
  }, false);
  mainWindow.show();

  if (DEBUG_LAYOUT) {
    console.log("RESIZE PET WINDOW", size);
    console.log("PET WINDOW DEBUG", {
      catScale: size.catScale,
      windowWidth: size.windowWidth,
      windowHeight: size.windowHeight,
      petStageWidth: BASE_STAGE_WIDTH,
      petStageHeight: BASE_STAGE_HEIGHT,
      screenBounds,
      positionX,
      positionY
    });
  }
  return mainWindow.getBounds();
}

function moveWindowTo(win, x, y) {
  const bounds = win.getBounds();
  const nextX = Math.round(Number(x));
  const nextY = Math.round(Number(y));

  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    console.warn("moveWindowTo ignored invalid position", { x, y });
    return bounds;
  }

  // 使用 setBounds 而不是 setPosition，可能能绕过 macOS 的位置限制
  win.setBounds({
    x: nextX,
    y: nextY,
    width: bounds.width,
    height: bounds.height
  }, false);
  return win.getBounds();
}

function clampWindowPosition(win, nextPosition) {
  const bounds = win.getBounds();
  const requestedX = Number(nextPosition?.x);
  const requestedY = Number(nextPosition?.y);

  if (!Number.isFinite(requestedX) || !Number.isFinite(requestedY)) {
    console.warn("window move ignored invalid position", nextPosition);
    return {
      x: bounds.x,
      y: bounds.y
    };
  }

  // 完全移除边界限制，允许窗口移动到任何位置
  const x = Math.round(requestedX);
  const y = Math.round(requestedY);

  return {
    x,
    y
  };
}

function getWindowDisplayBounds(win) {
  const bounds = win.getBounds();
  return screen.getDisplayMatching(bounds).workArea;
}

function getWindowDisplayFullBounds(win) {
  const bounds = win.getBounds();
  return screen.getDisplayMatching(bounds).bounds;
}

function getPrimaryWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

// Window creation
function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");

  if (process.platform === "darwin") {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  resizePetWindow(DEFAULT_CAT_SCALE);
}

// Settings window
function getSettingsWindowPosition() {
  const petBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(petBounds);
  const workArea = display.workArea;
  const panelWidth = 340;
  const panelHeight = 560;
  const gap = 16;
  let placement = "right";
  let panelX = petBounds.x + petBounds.width + gap;
  let panelY = petBounds.y;

  if (panelX + panelWidth > workArea.x + workArea.width) {
    panelX = petBounds.x - panelWidth - gap;
    placement = "left";
  }

  if (panelX < workArea.x) {
    panelX = Math.min(Math.max(petBounds.x, workArea.x), workArea.x + workArea.width - panelWidth);
    panelY = petBounds.y - panelHeight - gap;
    placement = "top";
  }

  if (panelY < workArea.y) {
    panelY = petBounds.y + petBounds.height + gap;
    placement = placement === "top" ? "bottom" : placement;
  }

  panelY = Math.min(Math.max(panelY, workArea.y), workArea.y + workArea.height - panelHeight);
  panelX = Math.min(Math.max(panelX, workArea.x), workArea.x + workArea.width - panelWidth);

  if (DEBUG_LAYOUT) {
    console.log("settings panel position", {
      petWindowX: petBounds.x,
      petWindowY: petBounds.y,
      petWindowWidth: petBounds.width,
      petWindowHeight: petBounds.height,
      panelX,
      panelY,
      placement
    });
  }

  return { panelX, panelY, panelWidth, panelHeight };
}

function openSettingsWindow() {
  if (!mainWindow) return null;

  const { panelX, panelY, panelWidth, panelHeight } = getSettingsWindowPosition();

  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = new BrowserWindow({
      width: panelWidth,
      height: panelHeight,
      x: Math.round(panelX),
      y: Math.round(panelY),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    settingsWindow.loadFile(path.join(__dirname, "settings.html"));
    settingsWindow.on("closed", () => {
      settingsWindow = null;
    });
  } else {
    settingsWindow.setBounds({
      x: Math.round(panelX),
      y: Math.round(panelY),
      width: panelWidth,
      height: panelHeight
    }, false);
    settingsWindow.show();
    settingsWindow.focus();
  }

  return settingsWindow.getBounds();
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC: window bounds and movement
ipcMain.handle("window:get-bounds", () => {
  if (!mainWindow) return null;

  return {
    window: mainWindow.getBounds(),
    display: getWindowDisplayBounds(mainWindow),
    displayBounds: getWindowDisplayFullBounds(mainWindow),
    constraints: getWindowConstraints(mainWindow),
    debugLayout: DEBUG_LAYOUT,
    primaryWorkArea: getPrimaryWorkArea()
  };
});

ipcMain.handle("screen:get-primary-work-area", () => {
  return getPrimaryWorkArea();
});

function getWindowConstraints(win) {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const fullBounds = display.bounds;

  return {
    minX: fullBounds.x,
    maxX: fullBounds.x + fullBounds.width - bounds.width,
    minY: fullBounds.y,
    maxY: fullBounds.y + fullBounds.height - bounds.height,
    visualTopOffset: 0,
    verticalOverhang: 0
  };
}

ipcMain.handle("window:drag-to", (_event, nextPosition) => {
  if (!mainWindow) return null;

  const { x, y } = clampWindowPosition(mainWindow, nextPosition);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    console.warn("window:drag-to ignored invalid clamped position", { x, y, nextPosition });
    return mainWindow.getBounds();
  }

  return moveWindowTo(mainWindow, x, y);
});

ipcMain.handle("window:set-position-soft", (_event, nextPosition) => {
  if (!mainWindow) return null;

  const { x, y } = clampWindowPosition(mainWindow, nextPosition);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    console.warn("window:set-position-soft ignored invalid position", { x, y, nextPosition });
    return mainWindow.getBounds();
  }

  return moveWindowTo(mainWindow, x, y);
});

ipcMain.handle("window:set-position-for-walk", (_event, nextPosition) => {
  if (!mainWindow) return null;
  if (nextPosition?.mode !== "edge" && nextPosition?.mode !== "menu") {
    console.warn("window:set-position-for-walk ignored invalid mode", nextPosition?.mode);
    return mainWindow.getBounds();
  }
  if (!activeWalkToken || nextPosition?.token !== activeWalkToken) {
    console.warn("window:set-position-for-walk ignored inactive token", nextPosition?.token);
    return mainWindow.getBounds();
  }

  const { x, y } = clampWindowPosition(mainWindow, nextPosition);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    console.warn("window:set-position-for-walk ignored invalid position", { x, y, nextPosition });
    return mainWindow.getBounds();
  }

  const movedBounds = moveWindowTo(mainWindow, x, y);
  return movedBounds;
});

ipcMain.handle("get-pet-window-position", () => {
  if (!mainWindow) return null;

  const [x, y] = mainWindow.getPosition();
  return { x, y };
});

ipcMain.handle("set-pet-window-position", (_event, x, y) => {
  if (!mainWindow) return null;

  const targetX = Math.round(Number(x));
  const targetY = Math.round(Number(y));

  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    console.warn("set-pet-window-position ignored invalid position", { x, y });
    const [currentX, currentY] = mainWindow.getPosition();
    return { x: currentX, y: currentY };
  }

  const movedBounds = moveWindowTo(mainWindow, targetX, targetY);

  return {
    x: movedBounds.x,
    y: movedBounds.y
  };
});

ipcMain.handle("window:walk-begin", (_event, token) => {
  activeWalkToken = token || null;
  return { active: Boolean(activeWalkToken) };
});

ipcMain.handle("window:walk-end", (_event, token) => {
  if (!token || token === activeWalkToken) {
    activeWalkToken = null;
  }
  return { active: Boolean(activeWalkToken) };
});

// IPC: debugging helpers
ipcMain.handle("window:move-to-top-test", () => {
  if (!mainWindow) return null;

  const [x, y] = mainWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  mainWindow.setPosition(x, display.bounds.y - 20, false);
  return mainWindow.getBounds();
});

ipcMain.handle("window:move-to-absolute-top-test", () => {
  if (!mainWindow) return null;

  const [x, y] = mainWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  
  // 直接设置一个明显的负坐标
  const targetY = display.bounds.y - 100;
  console.log("TRYING TO MOVE TO TOP", {
    currentY: y,
    targetY,
    displayY: display.bounds.y
  });
  
  mainWindow.setBounds({
    x: x,
    y: targetY,
    width: mainWindow.getBounds().width,
    height: mainWindow.getBounds().height
  }, false);

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [actualX, actualY] = mainWindow.getPosition();
    console.log("moveToAbsoluteTopTest RESULT", {
      requestedY: targetY,
      actualY,
      success: actualY === targetY
    });
  }, 500);

  return mainWindow.getBounds();
});

// IPC: scale and settings sync
ipcMain.handle("window:set-scale", (event, scale, source = "slider") => {
  if (!mainWindow) return null;
  const bounds = resizePetWindow(scale);
  if (event.sender !== mainWindow.webContents) {
    mainWindow.webContents.send("pet:set-scale", { scale, source });
  }
  return bounds;
});

ipcMain.handle("resize-pet-window", (event, payload = {}) => {
  if (!mainWindow) return null;
  const scale = typeof payload === "number" ? payload : payload.catScale;
  const source = payload.source || "slider";
  const bounds = resizePetWindow(scale);

  if (event.sender !== mainWindow.webContents) {
    mainWindow.webContents.send("pet:set-scale", { scale, source });
  }

  return bounds;
});

ipcMain.handle("settings:set-rest-reminder-interval", (_event, intervalMs) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  mainWindow.webContents.send("pet:set-rest-reminder-interval", intervalMs);
  return { intervalMs };
});

ipcMain.handle("pet-stats:update", (_event, stats = {}) => {
  latestPetStats = {
    mood: Math.max(0, Math.min(100, Math.round(Number(stats.mood) || 0))),
    fullness: Math.max(0, Math.min(100, Math.round(Number(stats.fullness) || 0))),
    hydration: Math.max(0, Math.min(100, Math.round(Number(stats.hydration) || 0))),
    energy: Math.max(0, Math.min(100, Math.round(Number(stats.energy) || 0)))
  };

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("settings:pet-stats", latestPetStats);
  }

  return latestPetStats;
});

ipcMain.handle("settings:get-pet-stats", () => latestPetStats);

// IPC: menu window resizing
ipcMain.handle("window:expand-for-menu", (_event, scale) => {
  if (!mainWindow) return null;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds).bounds;
  const nextWidth = bounds.width + MENU_WINDOW_PADDING_X;
  const nextHeight = bounds.height + MENU_WINDOW_PADDING_Y;
  const rightSpace = display.x + display.width - (bounds.x + bounds.width);
  const bottomSpace = display.y + display.height - (bounds.y + bounds.height);
  const shiftX = rightSpace >= MENU_WINDOW_PADDING_X ? 0 : MENU_WINDOW_PADDING_X;
  const shiftY = bottomSpace >= MENU_WINDOW_PADDING_Y ? 0 : Math.round(MENU_WINDOW_PADDING_Y / 2);
  let nextX = bounds.x - shiftX;
  let nextY = bounds.y - shiftY;

  nextX = Math.max(display.x, Math.min(nextX, display.x + display.width - nextWidth));
  nextY = Math.max(display.y, Math.min(nextY, display.y + display.height - nextHeight));

  menuRestoreBounds = bounds;
  mainWindow.setBounds({
    x: nextX,
    y: nextY,
    width: nextWidth,
    height: nextHeight
  }, false);

  const expandedBounds = mainWindow.getBounds();
  return {
    window: expandedBounds,
    screenBounds: display,
    placement: shiftX ? "left" : "right",
    petOffsetX: bounds.x - expandedBounds.x,
    petOffsetY: bounds.y - expandedBounds.y
  };
});

ipcMain.handle("window:restore-after-menu", (_event, scale) => {
  if (!mainWindow) return null;
  if (menuRestoreBounds) {
    mainWindow.setBounds(menuRestoreBounds, false);
  }
  menuRestoreBounds = null;
  return mainWindow.getBounds();
});

ipcMain.handle("settings:open", () => {
  return openSettingsWindow();
});

ipcMain.handle("settings:close", () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.hide();
  }
});

// IPC: cursor, quit, and small utilities
ipcMain.handle("window:nudge", (_event, delta) => {
  if (!mainWindow) return null;

  const bounds = mainWindow.getBounds();
  const { x, y } = clampWindowPosition(mainWindow, {
    x: bounds.x + delta.x,
    y: bounds.y + delta.y
  });

  mainWindow.setPosition(Math.round(x), Math.round(y), false);
  return mainWindow.getBounds();
});

ipcMain.handle("cursor:get-position", () => {
  return screen.getCursorScreenPoint();
});

ipcMain.handle("app:quit", () => {
  app.quit();
});
