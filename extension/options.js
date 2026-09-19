const DEFAULTS = { server: "http://localhost:8880", voice: "af_heart" };
const $ = (id) => document.getElementById(id);

async function loadVoices(server, selected) {
  const sel = $("voice");
  try {
    const voices = await (await fetch(`${server.replace(/\/+$/, "")}/api/voices`)).json();
    sel.innerHTML = voices.map((v) =>
      `<option value="${v.id}" ${v.id === selected ? "selected" : ""}>${v.name} · ${v.language}, ${v.gender} · ${v.character.join(", ")}${v.grade ? " · " + v.grade : ""}</option>`
    ).join("");
    $("status").textContent = "";
  } catch {
    sel.innerHTML = `<option>${selected}</option>`;
    $("status").textContent = "Server not reachable";
  }
}

chrome.storage.sync.get(DEFAULTS, ({ server, voice }) => {
  $("server").value = server;
  loadVoices(server, voice);
});
$("server").addEventListener("change", () => loadVoices($("server").value, $("voice").value));
$("save").addEventListener("click", () => {
  chrome.storage.sync.set({ server: $("server").value.trim() || DEFAULTS.server, voice: $("voice").value }, () => {
    $("status").textContent = "Saved";
  });
});
