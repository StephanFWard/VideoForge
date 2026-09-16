/* VideoForge web UI client. Talks to src/server.js. */
const $ = (id) => document.getElementById(id);
const logEl = $('log'), bar = $('bar'), runCard = $('runCard');
let evtSource = null, sceneTotal = 0, sceneDone = 0;

async function refreshHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    const pill = (ok, label) => `<span class="pill ${ok ? 'ok' : 'bad'}">${label}</span>`;
    let html =
      pill(h.comfy?.ok, 'ComfyUI MCP') +
      pill(h.kokoro?.ok, 'Kokoro MCP') +
      pill(h.ffmpeg, 'ffmpeg') +
      (h.busy ? '<span class="pill busy">render in progress</span>' : '');
    if (h.hint) html += `<div class="hint">${h.hint}</div>`;
    $('health').innerHTML = html;
    return h;
  } catch {
    $('health').textContent = 'server unreachable';
    return null;
  }
}

/** Map an absolute output path onto the /media/ route. */
function mediaUrl(p) {
  if (!p) return null;
  const norm = String(p).replace(/\\/g, '/');
  const marker = norm.toLowerCase().indexOf('/output/');
  if (marker === -1) return null;
  return '/media/' + norm.slice(marker + '/output/'.length);
}

async function refreshRuns() {
  let data;
  try { data = await (await fetch('/api/runs')).json(); } catch { return; }
  const runs = document.createDocumentFragment();
  for (const run of data.runs ?? []) {
    const div = document.createElement('div');
    div.className = 'run';
    const m = run.manifest ?? {};
    const video = mediaUrl(run.output?.video ?? m.output?.video);
    const thumb = mediaUrl(run.output?.thumbnail ?? m.output?.thumbnail);
    div.innerHTML = `
      ${thumb ? `<img src="${thumb}" loading="lazy" />` : ''}
      <div class="meta">
        <strong>${run.title ?? run.topic ?? run.id}</strong>
        <small>${m.delivery ?? ''}${m.output?.durationSeconds ? ' · ' + m.output.durationSeconds.toFixed(1) + 's' : ''}
        · ${m.backend?.visuals ?? '?'} visuals · ${m.backend?.voice ?? '?'} narration · ${run.status}</small>
      </div>
      ${video ? `<video src="${video}" controls preload="metadata"></video>` : ''}`;

    // Delete option for finished runs (live ones can't be deleted yet).
    if (run.status === 'done') {
      const del = document.createElement('button');
      del.className = 'delete';
      del.type = 'button';
      del.textContent = 'Delete';
      del.title = 'Delete this video and its files from disk';
      del.addEventListener('click', () => deleteRun(run.id, del));
      div.appendChild(del);
    }

    runs.appendChild(div);
  }
  $('runs').replaceChildren(runs);
}

async function deleteRun(id, button) {
  if (!window.confirm('Delete this video and all of its files from disk? This cannot be undone.')) {
    return;
  }
  button.disabled = true;
  button.textContent = 'Deleting…';
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || res.statusText);
    refreshRuns();
  } catch (err) {
    window.alert(`Could not delete run: ${err.message}`);
    button.disabled = false;
    button.textContent = 'Delete';
  }
}

function appendLog(level, message) {
  const known = ['ok', 'warn', 'error', 'step', 'info'];
  const line = document.createElement('div');
  line.className = known.includes(level) ? level : 'info';
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(pct) { bar.style.width = Math.min(100, Math.max(0, pct)) + '%'; }

async function generate() {
  const topic = $('topic').value.trim();
  if (!topic) { $('topic').focus(); return; }
  const body = {
    topic,
    resolution: $('resolution').value,
    voice: $('voice').value,
    backend: $('backend').value,
  };
  const scenes = Number($('scenes').value) || 0;
  if (scenes > 0) body.scenes = scenes;

  $('generate').disabled = true;
  runCard.classList.remove('hidden');
  logEl.replaceChildren();
  sceneTotal = sceneDone = 0;
  setProgress(3);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || res.statusText);

    appendLog('info', `run ${data.id} queued — streaming progress…`);
    evtSource?.close();
    evtSource = new EventSource(`/api/runs/${data.id}/events`);
    evtSource.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.type === 'end') {
        evtSource.close(); evtSource = null;
        $('generate').disabled = false;
        refreshRuns(); refreshHealth();
        return;
      }
      if (e.type === 'log') appendLog(e.level, e.message);
      else if (e.type === 'scene-done') {
        sceneDone = e.scene; sceneTotal = e.total;
        appendLog('ok', `scene ${e.scene}/${e.total} complete`);
      } else if (e.type === 'segment') {
        appendLog('info', `segment ${e.scene}/${e.total} cut`);
      } else if (e.type === 'complete') {
        setProgress(100);
        appendLog('ok', `done → ${e.title} (${e.durationSeconds?.toFixed?.(1) ?? '?'}s)`);
      } else if (e.type === 'error') {
        appendLog('error', e.message);
      }
      if (sceneTotal) setProgress(3 + 92 * (sceneDone / sceneTotal));
    };
    evtSource.onerror = () => { /* transient; 'end' event or runs refresh recovers */ };
  } catch (err) {
    appendLog('error', err.message);
    $('generate').disabled = false;
  }
}

$('generate').addEventListener('click', generate);
$('topic').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') generate(); });
refreshHealth();
refreshRuns();
setInterval(refreshRuns, 30000);
