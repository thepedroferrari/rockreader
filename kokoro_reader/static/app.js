// RockReader: vanilla JS, no build step.
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

const audio = $("audio");
let doc = null;          // { meta, segments }
let index = 0;           // current segment
let generated = new Set();
let pollTimer = null;
let waitingFor = null;   // segment index we are waiting on
let saveTimer = null;

// ---------- library ----------

// Voice picker: grouped by accent and gender, best-graded first, with measured character words.
const GRADE_ORDER = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F"];
function voiceLabel(v) {
  const grade = v.grade ? ` · grade ${v.grade}` : "";
  return `${v.name} · ${v.character.join(", ")}${grade}`;
}
async function loadVoices() {
  const voices = await api("/api/voices");
  const groups = new Map();
  for (const v of voices) {
    const key = `${v.language}, ${v.gender}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const rank = (v) => (v.grade ? GRADE_ORDER.indexOf(v.grade) : 99);
  let html = "";
  for (const [key, list] of groups) {
    list.sort((a, b) => rank(a) - rank(b));
    html += `<optgroup label="${key}">` + list.map((v) => `<option value="${v.id}">${voiceLabel(v)}</option>`).join("") + `</optgroup>`;
  }
  for (const sel of [$("upload-voice"), $("voice")]) sel.innerHTML = html;
  $("upload-voice").value = localStorage.getItem("voice") || "af_heart";
}

// Preview: plays a sample sentence in the voice chosen in the select next to the button.
const previewAudio = new Audio();
for (const btn of document.querySelectorAll(".preview")) {
  btn.addEventListener("click", () => {
    const voice = $(btn.dataset.for).value;
    if (!previewAudio.paused && previewAudio.dataset.voice === voice) { previewAudio.pause(); return; }
    if (!audio.paused) audio.pause();
    previewAudio.src = `/api/voices/${voice}/preview`;
    previewAudio.dataset.voice = voice;
    previewAudio.play().catch(() => {});
  });
}

async function showLibrary() {
  history.replaceState(null, "", "/");
  stop();
  doc = null;
  $("reader").hidden = true; $("player").hidden = true; $("back").hidden = true;
  $("library").hidden = false;
  $("title").textContent = "RockReader";
  $("status").textContent = "";
  const docs = await api("/api/docs");
  $("docs").innerHTML = docs.map((d) => {
    const pct = Math.round((d.position.segment / Math.max(1, d.segment_count - 1)) * 100);
    return `<li data-id="${d.id}">
      <div class="name"><b>${escape(d.title)}</b>
        <span class="muted">${d.segment_count} paragraphs · ${d.voice} · ${pct}% read</span></div>
      <button class="del" title="Delete">&#10005;</button></li>`;
  }).join("") || `<li class="muted">No documents yet.</li>`;
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
function refreshUploadButton() {
  const ok = inputMode === "file" ? $("file").files.length > 0
    : inputMode === "paste" ? $("paste-text").value.trim().length > 0
    : $("url").value.trim().length > 0;
  $("upload-btn").disabled = !ok;
}
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
  localStorage.setItem("voice", voice);
  $("upload-btn").disabled = true; $("upload-btn").textContent = inputMode === "url" ? "Fetching…" : "Extracting text…";
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  $("voice").value = doc.meta.voice;
  $("text").innerHTML = doc.segments.map((s, i) => `<p data-i="${i}">${escape(s)}</p>`).join("");
  $("export").href = `/api/docs/${id}/export`;
  audio.playbackRate = parseFloat($("speed").value);
  await refreshStatus();
  highlight();
  scrollToCurrent();
  const offset = doc.meta.position.offset || 0;
  loadSegment(index, false, offset);
  startPolling();
}

$("back").addEventListener("click", showLibrary);
$("text").addEventListener("click", (e) => {
  const p = e.target.closest("p[data-i]");
  if (p) jump(parseInt(p.dataset.i, 10), true);
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
    // Not synthesised yet: mark it wanted and wait for the poller.
    waitingFor = { i, autoplay, offset };
    $("status").textContent = "generating…";
    await refreshStatus();
    if (!generated.has(i)) return;
    waitingFor = null;
  }
  $("status").textContent = "";
  audio.src = url;
  audio.playbackRate = parseFloat($("speed").value);
  audio.currentTime = offset;
  if (autoplay) audio.play().catch(() => {});
  updateMediaSession();
  prefetch(i + 1);
}

function prefetch(i) {
  if (doc && i < doc.segments.length && generated.has(i)) {
    fetch(`/api/docs/${doc.meta.id}/audio/${i}`).catch(() => {});
  }
}

audio.addEventListener("ended", () => {
  if (index + 1 < doc.segments.length) { index++; highlight(); scrollToCurrent(); savePosition(0, true); loadSegment(index, true); }
  else { savePosition(0, true); $("play").innerHTML = "&#9654;"; }
});
audio.addEventListener("play", () => { $("play").innerHTML = "&#10074;&#10074;"; });
audio.addEventListener("pause", () => { $("play").innerHTML = "&#9654;"; savePosition(audio.currentTime, true); });
audio.addEventListener("timeupdate", () => savePosition(audio.currentTime, false));

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
$("speed").addEventListener("change", () => { audio.playbackRate = parseFloat($("speed").value); localStorage.setItem("speed", $("speed").value); });
$("voice").addEventListener("change", async () => {
  await api(`/api/docs/${doc.meta.id}/voice`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: $("voice").value }) });
  doc.meta.voice = $("voice").value;
  generated = new Set();
  const wasPlaying = !audio.paused;
  audio.pause();
  await refreshStatus();
  loadSegment(index, wasPlaying, 0);
});

function seekBy(s) {
  if (!audio.src) return;
  const t = audio.currentTime + s;
  if (t < 0 && index > 0) jump(index - 1, !audio.paused);
  else if (audio.duration && t > audio.duration) jump(index + 1, !audio.paused);
  else audio.currentTime = Math.max(0, t);
}

document.addEventListener("keydown", (e) => {
  if (!doc || e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  else if (e.code === "ArrowLeft") seekBy(-15);
  else if (e.code === "ArrowRight") seekBy(15);
  else if (e.code === "ArrowUp") { e.preventDefault(); $("prev").click(); }
  else if (e.code === "ArrowDown") { e.preventDefault(); $("next").click(); }
});

// ---------- status polling ----------

async function refreshStatus() {
  if (!doc) return;
  const st = await api(`/api/docs/${doc.meta.id}/status`);
  generated = new Set(st.generated);
  const ps = $("text").children;
  for (let i = 0; i < ps.length; i++) {
    ps[i].classList.toggle("ready", generated.has(i));
    ps[i].classList.toggle("generating", st.generating === i);
  }
  $("genfill").style.width = `${(generated.size / st.total) * 100}%`;
  $("counter").textContent = `${index + 1} / ${st.total}`;
  const complete = generated.size >= st.total;
  $("export").classList.toggle("disabled", !complete);
  $("export").title = complete ? "Download as one MP3" : `Generated ${generated.size} of ${st.total} paragraphs`;
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
  $("counter").textContent = `${index + 1} / ${doc.segments.length}`;
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
  if (now) { clearTimeout(saveTimer); send(); }
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
  $("speed").value = localStorage.getItem("speed") || "1";
  await loadVoices();
  const id = location.hash.slice(1);
  if (id) { try { await openDoc(id); return; } catch {} }
  showLibrary();
})();
