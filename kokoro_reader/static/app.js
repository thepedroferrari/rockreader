// RockReader: vanilla JS, no build step.
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const audio = $("audio");
let doc = null;          // { meta, segments }
let index = 0;           // current segment
let generated = new Set();
let pollTimer = null;
let waitingFor = null;   // { i, autoplay, offset } while the segment is still being synthesised
let saveTimer = null;
let voices = [];         // catalog from /api/voices
let segStarts = [];      // cumulative character offsets, for the track
let totalChars = 0;

// ---------- voices ----------

const GRADE_ORDER = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F"];
const voiceById = (id) => voices.find((v) => v.id === id);

async function loadVoices() {
  voices = await api("/api/voices");
  const rank = (v) => (v.grade ? GRADE_ORDER.indexOf(v.grade) : 99);
  const groups = new Map();
  for (const v of voices) {
    const key = `${v.language}, ${v.gender}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  let html = "";
  for (const [key, list] of groups) {
    list.sort((a, b) => rank(a) - rank(b));
    html += `<h4>${key}</h4>` + list.map((v) => `
      <div class="voice" data-id="${v.id}" role="option">
        <div><div class="vname">${v.name}${v.grade ? `<span class="grade">grade ${v.grade}</span>` : ""}</div>
             <div class="vdesc">${v.character.join(", ")}</div></div>
        <button type="button" class="icon play" data-preview="${v.id}" title="Hear a sample" aria-label="Hear ${v.name}">&#9654;</button>
      </div>`).join("");
  }
  $("voice-list").innerHTML = html;
  setVoiceInput("upload-voice", localStorage.getItem("voice") || "af_heart");
}

function setVoiceInput(inputId, id) {
  const v = voiceById(id) || voices[0];
  if (!v) return;
  $(inputId).value = v.id;
  const btn = document.querySelector(`.voice-btn[data-for="${inputId}"]`);
  btn.innerHTML = inputId === "voice" ? `<b>${v.name}</b>` : `Voice: <b>${v.name}</b>`;
  btn.title = `${v.name}: ${v.language}, ${v.gender}, ${v.character.join(", ")}`;
}

let pickerTarget = null;
const previewAudio = new Audio();
function openPicker(inputId) {
  pickerTarget = inputId;
  const cur = $(inputId).value;
  for (const row of document.querySelectorAll(".voice")) row.classList.toggle("current", row.dataset.id === cur);
  $("voice-pop").hidden = false; $("scrim").hidden = false;
  document.querySelector(".voice.current")?.scrollIntoView({ block: "center" });
}
function closePicker() { $("voice-pop").hidden = true; $("scrim").hidden = true; previewAudio.pause(); pickerTarget = null; }
for (const btn of document.querySelectorAll(".voice-btn")) btn.addEventListener("click", () => openPicker(btn.dataset.for));
$("voice-close").addEventListener("click", closePicker);
$("scrim").addEventListener("click", closePicker);
$("voice-list").addEventListener("click", async (e) => {
  const play = e.target.closest("[data-preview]");
  if (play) {
    const id = play.dataset.preview;
    if (!previewAudio.paused && previewAudio.dataset.voice === id) { previewAudio.pause(); return; }
    if (!audio.paused) audio.pause();
    previewAudio.src = `/api/voices/${id}/preview`; previewAudio.dataset.voice = id;
    previewAudio.play().catch(() => {});
    return;
  }
  const row = e.target.closest(".voice");
  if (!row) return;
  const id = row.dataset.id;
  const target = pickerTarget;
  closePicker();
  setVoiceInput(target, id);
  if (target === "upload-voice") localStorage.setItem("voice", id);
  else if (doc && id !== doc.meta.voice) await changeVoice(id);
});

async function changeVoice(id) {
  await api(`/api/docs/${doc.meta.id}/voice`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: id }) });
  doc.meta.voice = id;
  generated = new Set();
  const wasPlaying = !audio.paused;
  audio.pause();
  await refreshStatus();
  loadSegment(index, wasPlaying, 0);
}

// ---------- library ----------

async function showLibrary() {
  history.replaceState(null, "", "/");
  stop();
  if (doc && doc.meta.ephemeral) fetch(`/api/docs/${doc.meta.id}`, { method: "DELETE" }).catch(() => {});
  doc = null;
  $("keep").hidden = true;
  $("reader").hidden = true; $("player").hidden = true; $("back").hidden = true;
  $("library").hidden = false;
  $("title").textContent = "RockReader";
  $("status").textContent = "";
  const docs = await api("/api/docs");
  $("docs").innerHTML = docs.map((d) => {
    const pct = Math.round((d.position.segment / Math.max(1, d.segment_count - 1)) * 100);
    const v = voiceById(d.voice);
    return `<li data-id="${d.id}">
      <div class="name"><b>${escape(d.title)}</b>
        <span class="muted">${d.segment_count} paragraph${d.segment_count === 1 ? "" : "s"} · ${v ? v.name : d.voice} · ${pct}% read</span></div>
      <button class="del" title="Delete" aria-label="Delete">&#10005;</button></li>`;
  }).join("") || `<li class="muted">Nothing here yet. Add a file, paste text, or drop in a link above.</li>`;
}

$("docs").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  if (e.target.classList.contains("del")) {
    if (confirm("Delete this document and its audio?")) {
      await api(`/api/docs/${li.dataset.id}`, { method: "DELETE" });
      showLibrary();
    }
    return;
  }
  openDoc(li.dataset.id);
});

let inputMode = "file";
let quickMax = 10000;
api("/api/config").then((c) => { quickMax = c.quick_listen_max_chars; refreshUploadButton(); }).catch(() => {});
function refreshUploadButton() {
  const text = $("paste-text").value;
  const ok = inputMode === "file" ? $("file").files.length > 0
    : inputMode === "paste" ? text.trim().length > 0
    : $("url").value.trim().length > 0;
  $("upload-btn").disabled = !ok;
  const paste = inputMode === "paste";
  $("listen-btn").hidden = !paste;
  const over = text.length > quickMax;
  $("listen-btn").disabled = !ok || over;
  $("upload-btn").classList.toggle("primary", !paste || over);
  $("listen-btn").classList.toggle("primary", paste && !over);
  if (paste) {
    $("paste-count").textContent = text.length === 0 ? `Up to ${quickMax.toLocaleString()} characters can be listened to right away without saving.`
      : over ? `${text.length.toLocaleString()} characters. That is over ${quickMax.toLocaleString()}, so add it to the library and it will play as it generates.`
      : `${text.length.toLocaleString()} / ${quickMax.toLocaleString()} characters`;
  }
}
$("listen-btn").addEventListener("click", async () => {
  const voice = $("upload-voice").value;
  $("listen-btn").disabled = true; $("listen-btn").textContent = "Preparing…";
  try {
    const meta = await api("/api/docs/text", json({ title: $("paste-title").value || "Quick listen", text: $("paste-text").value, voice, ephemeral: true }));
    $("upload").reset();
    $("file").dispatchEvent(new Event("change"));
    await openDoc(meta.id);
    $("play").click();
  } catch (err) {
    alert(err.message);
  } finally {
    $("listen-btn").textContent = "Listen now";
    refreshUploadButton();
  }
});
$("keep").addEventListener("click", async () => {
  if (!doc) return;
  const meta = await api(`/api/docs/${doc.meta.id}/keep`, { method: "PUT" });
  doc.meta.ephemeral = meta.ephemeral;
  $("keep").hidden = true;
  $("status").textContent = "saved";
  setTimeout(() => { if ($("status").textContent === "saved") $("status").textContent = ""; }, 2000);
});
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    inputMode = tab.dataset.tab;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll(".pane")) p.hidden = p.dataset.pane !== inputMode;
    refreshUploadButton();
  });
}
$("file").addEventListener("change", () => {
  const f = $("file").files[0];
  $("drop-label").textContent = f ? f.name : "Drop a PDF, EPUB, TXT or Markdown file here, or click to choose";
  refreshUploadButton();
});
$("paste-text").addEventListener("input", refreshUploadButton);
$("url").addEventListener("input", refreshUploadButton);
const drop = document.querySelector(".drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  $("file").files = e.dataTransfer.files; $("file").dispatchEvent(new Event("change"));
});
$("upload").addEventListener("submit", async (e) => {
  e.preventDefault();
  const voice = $("upload-voice").value;
  $("upload-btn").disabled = true; $("upload-btn").textContent = inputMode === "url" ? "Fetching…" : "Extracting text…";
  try {
    let meta;
    if (inputMode === "file") {
      const fd = new FormData();
      fd.append("file", $("file").files[0]);
      meta = await api(`/api/docs?voice=${voice}`, { method: "POST", body: fd });
    } else if (inputMode === "paste") {
      meta = await api("/api/docs/text", json({ title: $("paste-title").value, text: $("paste-text").value, voice }));
    } else {
      meta = await api("/api/docs/url", json({ url: $("url").value, voice }));
    }
    $("upload").reset();
    $("file").dispatchEvent(new Event("change"));
    openDoc(meta.id);
  } catch (err) {
    alert(err.message);
  } finally {
    $("upload-btn").textContent = "Add to library";
  }
});

// ---------- reader ----------

async function openDoc(id) {
  doc = await api(`/api/docs/${id}`);
  history.replaceState(null, "", `/#${id}`);
  index = doc.meta.position.segment;
  $("library").hidden = true; $("reader").hidden = false; $("player").hidden = false; $("back").hidden = false;
  $("title").textContent = doc.meta.title;
  $("keep").hidden = !doc.meta.ephemeral;
  setVoiceInput("voice", doc.meta.voice);
  $("text").innerHTML = doc.segments.map((s, i) => `<p data-i="${i}">${escape(s)}</p>`).join("");
  $("export").href = `/api/docs/${id}/export?format=ogg`;
  segStarts = []; totalChars = 0;
  for (const s of doc.segments) { segStarts.push(totalChars); totalChars += s.length; }
  $("track-segments").innerHTML = doc.segments.map((s, i) => `<i data-i="${i}" style="--w:${s.length}"></i>`).join("");
  applySpeed();
  await refreshStatus();
  highlight();
  scrollToCurrent();
  loadSegment(index, false, doc.meta.position.offset || 0);
  startPolling();
}

$("back").addEventListener("click", showLibrary);
$("text").addEventListener("click", (e) => {
  const p = e.target.closest("p[data-i]");
  if (p) jump(parseInt(p.dataset.i, 10), true);
});
$("track").addEventListener("click", (e) => {
  const rect = $("track-segments").getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const chars = frac * totalChars;
  let i = segStarts.findIndex((start, k) => chars < start + doc.segments[k].length);
  jump(i < 0 ? doc.segments.length - 1 : i, !audio.paused);
});

function jump(i, autoplay) {
  if (!doc) return;
  index = Math.max(0, Math.min(i, doc.segments.length - 1));
  highlight(); scrollToCurrent();
  savePosition(0, true);
  loadSegment(index, autoplay, 0);
}

async function loadSegment(i, autoplay, offset = 0) {
  waitingFor = null;
  const url = `/api/docs/${doc.meta.id}/audio/${i}`;
  if (!generated.has(i)) {
    waitingFor = { i, autoplay, offset };
    $("status").textContent = "generating…";
    await refreshStatus();
    if (!generated.has(i)) return;
    waitingFor = null;
  }
  $("status").textContent = "";
  audio.src = url;
  applySpeed();
  audio.currentTime = offset;
  if (autoplay) audio.play().catch(() => {});
  updateMediaSession();
  prefetch(i + 1);
}

function prefetch(i) {
  if (doc && i < doc.segments.length && generated.has(i)) fetch(`/api/docs/${doc.meta.id}/audio/${i}`).catch(() => {});
}

audio.addEventListener("ended", () => {
  if (index + 1 < doc.segments.length) { index++; highlight(); scrollToCurrent(); savePosition(0, true); loadSegment(index, true); }
  else { savePosition(0, true); setPlaying(false); }
});
audio.addEventListener("play", () => setPlaying(true));
audio.addEventListener("pause", () => { setPlaying(false); savePosition(audio.currentTime, true); });
audio.addEventListener("timeupdate", () => { savePosition(audio.currentTime, false); updateReadout(); });
audio.addEventListener("loadedmetadata", updateReadout);

function setPlaying(on) {
  $("play").classList.toggle("playing", on);
  $("play").querySelector("span").innerHTML = on ? "&#10074;&#10074;" : "&#9654;";
  $("play").setAttribute("aria-label", on ? "Pause" : "Play");
}

$("play").addEventListener("click", () => {
  if (!doc) return;
  if (audio.paused) {
    if (!audio.src || waitingFor) loadSegment(index, true, audio.currentTime || 0);
    else audio.play().catch(() => {});
  } else audio.pause();
});
$("prev").addEventListener("click", () => jump(audio.currentTime > 3 ? index : index - 1, !audio.paused));
$("next").addEventListener("click", () => jump(index + 1, !audio.paused));
$("rew").addEventListener("click", () => seekBy(-15));
$("ffw").addEventListener("click", () => seekBy(15));

const SPEED_PRESETS = [0.8, 1, 1.2, 1.5, 1.75, 2, 2.5];
const getSpeed = () => parseFloat(localStorage.getItem("speed") || "1");
function setSpeed(s) {
  s = Math.round(Math.min(3, Math.max(0.5, s)) * 20) / 20;
  localStorage.setItem("speed", String(s));
  applySpeed();
}
function applySpeed() {
  const s = getSpeed();
  audio.playbackRate = s;
  const label = `${s}×`;
  $("speed").textContent = label; $("speed-value").textContent = label;
  $("speed-range").value = s;
  for (const b of $("speed-chips").children) b.classList.toggle("on", parseFloat(b.dataset.s) === s);
  updateReadout();
}
$("speed-chips").innerHTML = SPEED_PRESETS.map((s) => `<button type="button" data-s="${s}">${s}×</button>`).join("");
$("speed-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b) setSpeed(parseFloat(b.dataset.s)); });
$("speed-range").addEventListener("input", () => setSpeed(parseFloat($("speed-range").value)));
let speedOpen = false;
function openSpeed() { speedOpen = true; $("speed-pop").hidden = false; $("scrim").hidden = false; $("speed-range").focus(); }
function closeSpeed() { speedOpen = false; $("speed-pop").hidden = true; if (!pickerTarget) $("scrim").hidden = true; }
$("speed").addEventListener("click", () => (speedOpen ? closeSpeed() : openSpeed()));
$("scrim").addEventListener("click", closeSpeed);

function seekBy(s) {
  if (!audio.src) return;
  const t = audio.currentTime + s;
  if (t < 0 && index > 0) jump(index - 1, !audio.paused);
  else if (audio.duration && t > audio.duration) jump(index + 1, !audio.paused);
  else audio.currentTime = Math.max(0, t);
}

document.addEventListener("keydown", (e) => {
  if (e.code === "Escape" && (pickerTarget || speedOpen)) { closePicker(); closeSpeed(); return; }
  if (!doc || pickerTarget || (["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName) && e.target.id !== "speed-range")) return;
  if (e.key === "[") { setSpeed(getSpeed() - 0.1); return; }
  if (e.key === "]") { setSpeed(getSpeed() + 0.1); return; }
  if (speedOpen) return;
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  else if (e.code === "ArrowLeft") seekBy(-15);
  else if (e.code === "ArrowRight") seekBy(15);
  else if (e.code === "ArrowUp") { e.preventDefault(); $("prev").click(); }
  else if (e.code === "ArrowDown") { e.preventDefault(); $("next").click(); }
});

// ---------- readout and track ----------

const fmt = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function updateReadout() {
  if (!doc) return;
  const dur = audio.duration || 0, t = audio.currentTime || 0;
  $("clock").textContent = `${fmt(t)} / ${fmt(dur)}`;
  // Time left: words still to hear at this voice's measured pace and the chosen speed.
  const v = voiceById(doc.meta.voice);
  const wps = (v && v.metrics && v.metrics.words_per_sec) || 2.4;
  const rate = audio.playbackRate || 1;
  let words = 0;
  for (let k = index + 1; k < doc.segments.length; k++) words += doc.segments[k].split(/\s+/).length;
  const left = words / wps / rate + (dur ? (dur - t) / rate : doc.segments[index].split(/\s+/).length / wps / rate);
  $("remaining").textContent = left >= 90 ? `about ${Math.round(left / 60)} min left` : `under 2 min left`;
  const frac = dur ? t / dur : 0;
  const pos = totalChars ? (segStarts[index] + frac * doc.segments[index].length) / totalChars : 0;
  $("track-pos").style.left = `calc(16px + ${(pos * 100).toFixed(3)}% - ${(pos * 32).toFixed(1)}px)`;
}

// ---------- status polling ----------

async function refreshStatus() {
  if (!doc) return;
  const st = await api(`/api/docs/${doc.meta.id}/status`);
  generated = new Set(st.generated);
  const ps = $("text").children, bars = $("track-segments").children;
  for (let i = 0; i < ps.length; i++) {
    ps[i].classList.toggle("ready", generated.has(i));
    ps[i].classList.toggle("generating", st.generating === i);
    if (bars[i]) bars[i].classList.toggle("ready", generated.has(i));
  }
  const complete = generated.size >= st.total;
  $("export").classList.toggle("disabled", !complete);
  $("export").title = complete ? "Download the whole document as one Opus audio file" : `Export is ready once every paragraph is generated (${generated.size} of ${st.total})`;
  if (waitingFor && generated.has(waitingFor.i)) {
    const w = waitingFor; waitingFor = null;
    loadSegment(w.i, w.autoplay, w.offset);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (doc) refreshStatus().catch(() => {}); }, 1500);
}

function stop() { clearInterval(pollTimer); audio.pause(); audio.removeAttribute("src"); waitingFor = null; }

// ---------- helpers ----------

function highlight() {
  for (const p of $("text").querySelectorAll("p.current")) p.classList.remove("current");
  const cur = $("text").children[index];
  if (cur) cur.classList.add("current");
  $("counter").textContent = `Paragraph ${index + 1} of ${doc.segments.length}`;
  updateReadout();
}
function scrollToCurrent() {
  const cur = $("text").children[index];
  if (cur) cur.scrollIntoView({ block: "center", behavior: "smooth" });
}
function savePosition(offset, now) {
  if (!doc) return;
  doc.meta.position = { segment: index, offset };
  const send = () => fetch(`/api/docs/${doc.meta.id}/position`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segment: index, offset }),
  }).catch(() => {});
  if (now) { clearTimeout(saveTimer); saveTimer = null; send(); }
  else if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; send(); }, 5000);
}
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: doc.meta.title, artist: `Paragraph ${index + 1} of ${doc.segments.length}` });
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => $("prev").click());
  navigator.mediaSession.setActionHandler("nexttrack", () => $("next").click());
  navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
  navigator.mediaSession.setActionHandler("seekforward", () => seekBy(15));
}
function escape(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- boot ----------

(async () => {
  await loadVoices();
  const id = location.hash.slice(1);
  if (id) { try { await openDoc(id); return; } catch {} }
  showLibrary();
})();
