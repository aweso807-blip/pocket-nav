const statusEl = document.getElementById("status");
const nextTurnEl = document.getElementById("nextTurn");
const destinationInput = document.getElementById("destinationInput");
const suggestionsEl = document.getElementById("suggestions");
const setCurrentBtn = document.getElementById("setCurrentBtn");
const routeBtn = document.getElementById("routeBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const map = L.map("map");
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);
map.setView([37.7749, -122.4194], 13);

let currentPos = null;
let destinationPos = null;
let userMarker = null;
let destinationMarker = null;
let routeLine = null;
let routeCoords = [];
let routeSteps = [];
let activeStepIndex = 0;
let watchId = null;
let lastOffRouteMs = 0;
let lastDisconnectedMs = 0;
let lastRerouteMs = 0;
let isRerouting = false;
let suggestionTimer = null;
let suggestionAbort = null;
let selectedSuggestion = null;
let wakeLock = null;

setCurrentBtn.addEventListener("click", setCurrentLocation);
routeBtn.addEventListener("click", buildRoute);
startBtn.addEventListener("click", startNavigation);
stopBtn.addEventListener("click", () => stopNavigation(true));
destinationInput.addEventListener("input", onDestinationInput);

window.addEventListener("offline", () => {
  if (watchId) {
    setStatus("disconnected: network offline");
    doSignal("disconnected");
  }
});
window.addEventListener("online", () => {
  if (watchId) {
    setStatus("network restored");
  }
});
document.addEventListener("visibilitychange", () => {
  if (watchId && document.visibilityState === "hidden") {
    setStatus("background mode active (web may pause when locked)");
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function setNextTurn(text) {
  nextTurnEl.textContent = `Next turn: ${text}`;
}

function onDestinationInput() {
  selectedSuggestion = null;
  destinationPos = null;
  drawSuggestions([]);
  clearTimeout(suggestionTimer);
  const query = destinationInput.value.trim();
  if (query.length < 2) return;
  suggestionTimer = setTimeout(() => fetchSuggestions(query), 220);
}

async function setCurrentLocation() {
  if (!navigator.geolocation) {
    setStatus("geolocation unavailable");
    return;
  }

  setStatus("locating...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentPos = [pos.coords.latitude, pos.coords.longitude];
      drawUserMarker(currentPos);
      map.setView(currentPos, 15);
      setStatus("current location set");
    },
    (err) => setStatus(`location error: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
  );
}

async function fetchSuggestions(query) {
  try {
    if (suggestionAbort) suggestionAbort.abort();
    suggestionAbort = new AbortController();
    const url = makeNominatimSearchUrl(query);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: suggestionAbort.signal
    });
    if (!res.ok) throw new Error("suggestion lookup failed");
    const results = await res.json();
    const suggestions = (results || []).map((r) => {
      const pos = [Number(r.lat), Number(r.lon)];
      const distance = currentPos ? haversineMeters(currentPos, pos) : Number.POSITIVE_INFINITY;
      return {
        label: r.display_name,
        latlng: pos,
        distance
      };
    });
    suggestions.sort((a, b) => a.distance - b.distance);
    drawSuggestions(suggestions.slice(0, 6));
  } catch (err) {
    if (err.name !== "AbortError") setStatus("suggestions unavailable");
  }
}

function makeNominatimSearchUrl(query) {
  const base = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&addressdetails=1&q=${encodeURIComponent(query)}`;
  if (!currentPos) return base;
  const lat = currentPos[0];
  const lon = currentPos[1];
  const delta = 0.12;
  const viewbox = `${lon - delta},${lat + delta},${lon + delta},${lat - delta}`;
  return `${base}&viewbox=${viewbox}&bounded=0`;
}

function drawSuggestions(list) {
  if (!list.length) {
    suggestionsEl.style.display = "none";
    suggestionsEl.innerHTML = "";
    return;
  }
  suggestionsEl.style.display = "block";
  suggestionsEl.innerHTML = list.map((s, i) => {
    const distanceTxt = Number.isFinite(s.distance) ? `~${formatMeters(s.distance)} away` : "distance unavailable";
    return `<button class="suggestion-item" data-idx="${i}">${escapeHtml(s.label)}<small>${distanceTxt}</small></button>`;
  }).join("");
  suggestionsEl.querySelectorAll(".suggestion-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      selectSuggestion(list[idx]);
    });
  });
}

function selectSuggestion(s) {
  selectedSuggestion = s;
  destinationPos = s.latlng;
  destinationInput.value = s.label;
  drawSuggestions([]);
  drawDestinationMarker(destinationPos);
  map.setView(destinationPos, 15);
  setStatus("destination selected");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function geocodePlace(query) {
  const url = makeNominatimSearchUrl(query);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    throw new Error("geocoder request failed");
  }
  const results = await res.json();
  if (!results.length) {
    throw new Error("destination not found");
  }
  const scored = results.map((r) => {
    const pos = [Number(r.lat), Number(r.lon)];
    return { r, pos, d: currentPos ? haversineMeters(currentPos, pos) : Number.POSITIVE_INFINITY };
  });
  scored.sort((a, b) => a.d - b.d);
  const first = scored[0].r;
  return [Number(first.lat), Number(first.lon)];
}

async function buildRoute() {
  try {
    if (!currentPos) {
      setStatus("set current location first");
      return;
    }
    const query = destinationInput.value.trim();
    if (!query) {
      setStatus("enter a destination");
      return;
    }
    if (!destinationPos) {
      setStatus("geocoding destination...");
      destinationPos = await geocodePlace(query);
    }
    drawDestinationMarker(destinationPos);
    await fetchAndRenderRoute();
    startBtn.disabled = false;
  } catch (err) {
    setStatus(err.message || "failed to build route");
  }
}

async function fetchAndRenderRoute() {
  setStatus("building route...");
  const [fromLat, fromLon] = currentPos;
  const [toLat, toLon] = destinationPos;
  const routeUrl =
    `https://router.project-osrm.org/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}` +
    "?overview=full&geometries=geojson&steps=true";
  const res = await fetch(routeUrl);
  if (!res.ok) {
    throw new Error("route request failed");
  }
  const data = await res.json();
  if (!data.routes?.length) {
    throw new Error("no route found");
  }
  const route = data.routes[0];
  routeCoords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  if (routeLine) routeLine.remove();
  routeLine = L.polyline(routeCoords, { color: "#22d3ee", weight: 6 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  routeSteps = normalizeSteps(route.legs);
  activeStepIndex = 0;
  setStatus(`route ready (${Math.round(route.distance)} m)`);
  setNextTurn(routeSteps[0]?.instruction || "straight to destination");
}

function normalizeSteps(legs) {
  const steps = [];
  for (const leg of legs || []) {
    for (const step of leg.steps || []) {
      const maneuver = step.maneuver || {};
      const modifier = (maneuver.modifier || "").toLowerCase();
      const type = (maneuver.type || "").toLowerCase();
      const instruction = step.name ? `${type} on ${step.name}` : type;
      const turnType = modifier.includes("uturn") || type.includes("uturn")
        ? "uturn"
        : modifier.includes("left")
        ? "left"
        : modifier.includes("right")
          ? "right"
          : "other";
      steps.push({
        turnType,
        instruction: `${instruction} (${modifier || "continue"})`,
        point: [maneuver.location[1], maneuver.location[0]],
        triggered: false,
        previewed: false,
        previewTimer: null
      });
    }
  }
  return steps;
}

async function startNavigation() {
  if (!routeCoords.length) {
    setStatus("build a route first");
    return;
  }
  if (!navigator.geolocation) {
    setStatus("geolocation unavailable");
    return;
  }
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
  }
  await requestWakeLock();
  watchId = navigator.geolocation.watchPosition(
    onLocationUpdate,
    (err) => {
      setStatus(`watch error: ${err.message}`);
      doSignal("gpslost");
    },
    { enableHighAccuracy: true, maximumAge: 1200, timeout: 15000 }
  );
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus("navigation running");
}

function stopNavigation(manual = false) {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();
  for (const step of routeSteps) {
    if (step.previewTimer) clearTimeout(step.previewTimer);
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (manual) doSignal("cancelled");
  setStatus("navigation stopped");
}

async function onLocationUpdate(pos) {
  currentPos = [pos.coords.latitude, pos.coords.longitude];
  drawUserMarker(currentPos);

  const toDest = haversineMeters(currentPos, destinationPos);
  if (toDest < 25) {
    doSignal("arrived");
    setStatus("arrived");
    setNextTurn("done");
    stopNavigation(false);
    return;
  }

  const routeDistance = distancePointToPolylineMeters(currentPos, routeCoords);
  if (routeDistance > 45) {
    const now = Date.now();
    if (now - lastOffRouteMs > 20000) {
      doSignal("offroute");
      lastOffRouteMs = now;
      setStatus("off-route warning");
    }
    if (navigator.onLine && now - lastRerouteMs > 30000 && !isRerouting) {
      isRerouting = true;
      lastRerouteMs = now;
      try {
        doSignal("rerouting");
        await fetchAndRenderRoute();
      } catch {
        setStatus("reroute failed");
      } finally {
        isRerouting = false;
      }
    }
  } else if (!navigator.onLine) {
    const now = Date.now();
    if (now - lastDisconnectedMs > 30000) {
      lastDisconnectedMs = now;
      doSignal("disconnected");
      setStatus("offline: rerouting unavailable");
    }
  }

  while (activeStepIndex < routeSteps.length && routeSteps[activeStepIndex].triggered) {
    activeStepIndex += 1;
  }
  const nextStep = routeSteps[activeStepIndex];
  if (!nextStep) {
    setNextTurn("continue to destination");
    return;
  }
  const d = haversineMeters(currentPos, nextStep.point);
  setNextTurn(`${nextStep.instruction} in ${formatMeters(d)}`);
  if (!nextStep.previewed && d <= 120) {
    nextStep.previewed = true;
    doSignal("preview");
    const idx = activeStepIndex;
    nextStep.previewTimer = setTimeout(() => {
      if (!watchId || nextStep.triggered || idx !== activeStepIndex) return;
      triggerTurnSignal(nextStep.turnType);
      nextStep.triggered = true;
      activeStepIndex += 1;
    }, 10000);
  }
  if (d <= 35) {
    if (nextStep.previewTimer) clearTimeout(nextStep.previewTimer);
    triggerTurnSignal(nextStep.turnType);
    nextStep.triggered = true;
    activeStepIndex += 1;
  }
}

function triggerTurnSignal(turnType) {
  if (turnType === "left") doSignal("left");
  if (turnType === "right") doSignal("right");
  if (turnType === "uturn") doSignal("uturn");
}

function drawUserMarker(latlng) {
  if (!userMarker) {
    userMarker = L.circleMarker(latlng, {
      radius: 8,
      color: "#0ea5e9",
      fillColor: "#38bdf8",
      fillOpacity: 0.9
    }).addTo(map);
  } else {
    userMarker.setLatLng(latlng);
  }
}

function drawDestinationMarker(latlng) {
  if (!destinationMarker) {
    destinationMarker = L.marker(latlng).addTo(map);
  } else {
    destinationMarker.setLatLng(latlng);
  }
}

function doSignal(type) {
  if (navigator.vibrate) {
    if (type === "right") navigator.vibrate([220]);
    if (type === "left") navigator.vibrate([150, 130, 150]);
    if (type === "preview") navigator.vibrate([80, 80, 80, 80, 80]);
    if (type === "uturn") navigator.vibrate([260, 120, 260, 120, 260]);
    if (type === "offroute") navigator.vibrate([1200]);
    if (type === "disconnected") navigator.vibrate([800, 200, 800]);
    if (type === "gpslost") navigator.vibrate([500, 120, 500, 120, 500]);
    if (type === "rerouting") navigator.vibrate([120, 90, 120, 90, 120, 90, 120]);
    if (type === "cancelled") navigator.vibrate([120, 90, 350]);
    if (type === "arrived") navigator.vibrate([100, 80, 100, 80, 280]);
  }
  playTone(type);
}

function playTone(type) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const ctx = new AudioCtx();
  const now = ctx.currentTime;
  const schedule = {
    right: [[0, 0.11, 660]],
    left: [[0, 0.08, 440], [0.16, 0.08, 440]],
    preview: [[0, 0.06, 720], [0.12, 0.06, 720], [0.24, 0.06, 720]],
    uturn: [[0, 0.11, 330], [0.2, 0.11, 300], [0.4, 0.11, 280]],
    offroute: [[0, 0.55, 180]],
    disconnected: [[0, 0.35, 220], [0.5, 0.35, 220]],
    gpslost: [[0, 0.15, 220], [0.2, 0.15, 220], [0.4, 0.15, 220]],
    rerouting: [[0, 0.06, 520], [0.1, 0.06, 600], [0.2, 0.06, 680], [0.3, 0.06, 760]],
    cancelled: [[0, 0.08, 480], [0.15, 0.2, 220]],
    arrived: [[0, 0.09, 740], [0.14, 0.09, 740], [0.28, 0.2, 900]]
  }[type];
  if (!schedule) return;
  for (const [start, dur, hz] of schedule) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = hz;
    osc.type = "sine";
    gain.gain.value = 0.001;
    osc.connect(gain).connect(ctx.destination);
    const t0 = now + start;
    gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  setTimeout(() => ctx.close().catch(() => {}), 1200);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    setStatus("wake lock unavailable; lock-screen reliability limited");
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function formatMeters(meters) {
  if (!Number.isFinite(meters)) return "n/a";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function haversineMeters(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distancePointToPolylineMeters(point, polyline) {
  if (!polyline.length) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const d = distanceToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

function distanceToSegmentMeters(p, a, b) {
  const latScale = 111320;
  const lonScale = Math.cos((p[0] * Math.PI) / 180) * 111320;
  const ax = a[1] * lonScale;
  const ay = a[0] * latScale;
  const bx = b[1] * lonScale;
  const by = b[0] * latScale;
  const px = p[1] * lonScale;
  const py = p[0] * latScale;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2)) : 0;
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}
