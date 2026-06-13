const { ipcRenderer } = require("electron");

// Shared defaults
const DEFAULT_CAT_SCALE = 0.55;
const MIN_CAT_SCALE = 0.25;
const MAX_CAT_SCALE = 1.0;
const DEFAULT_REST_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const REST_REMINDER_INTERVAL_KEY = "restReminderIntervalMs";
const DEFAULT_PET_STATS = {
  mood: 80,
  fullness: 80,
  hydration: 80,
  energy: 80
};

// DOM references
const scaleSlider = document.getElementById("scale-slider");
const scaleValue = document.getElementById("scale-value");
const scaleReset = document.getElementById("scale-reset");
const restReminderSelect = document.getElementById("rest-reminder-select");
const settingsClose = document.getElementById("settings-close");

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

// Reminder settings
function applyRestReminderInterval(intervalMs) {
  const safeInterval = Math.max(0, Number(intervalMs) || 0);
  localStorage.setItem(REST_REMINDER_INTERVAL_KEY, String(safeInterval));
  restReminderSelect.value = String(safeInterval);
  ipcRenderer.invoke("settings:set-rest-reminder-interval", safeInterval);
}

// Pet stats display
function renderPetStats(stats = DEFAULT_PET_STATS) {
  for (const [key, fallback] of Object.entries(DEFAULT_PET_STATS)) {
    const rawValue = Number(stats[key]);
    const value = Math.round(Math.max(0, Math.min(100, Number.isFinite(rawValue) ? rawValue : fallback)));
    const line = document.querySelector(`.status-line[data-stat="${key}"]`);
    if (!line) continue;

    line.querySelector("meter").value = value;
    line.querySelector("strong").textContent = String(value);
  }
}

async function loadPetStats() {
  const stats = await ipcRenderer.invoke("settings:get-pet-stats");
  renderPetStats(stats);
}

// Scale controls
async function applyScale(scale, source = "slider") {
  const savedScale = localStorage.getItem("catScale");
  const safeScale = Math.max(MIN_CAT_SCALE, Math.min(Number(scale) || DEFAULT_CAT_SCALE, MAX_CAT_SCALE));
  localStorage.setItem("catScale", String(safeScale));
  scaleSlider.value = String(safeScale);
  scaleValue.value = `${safeScale.toFixed(2)}x`;
  await ipcRenderer.invoke("resize-pet-window", { catScale: safeScale, source });
}

// Event bindings
scaleSlider.addEventListener("input", (event) => {
  applyScale(event.target.value, "slider");
});

scaleReset.addEventListener("click", () => {
  applyScale(DEFAULT_CAT_SCALE, "reset");
});

restReminderSelect.addEventListener("change", (event) => {
  applyRestReminderInterval(event.target.value);
});

settingsClose.addEventListener("click", (event) => {
  event.stopPropagation();
  ipcRenderer.invoke("settings:close");
});

ipcRenderer.on("settings:pet-stats", (_event, stats) => {
  renderPetStats(stats);
});

applyScale(readSavedCatScale(), localStorage.getItem("catScale") === null ? "default" : "localStorage");
applyRestReminderInterval(readRestReminderInterval());
loadPetStats();
