/* VideoForge web UI client. Talks to src/server.js. */
const $ = (id) => document.getElementById(id);
const logEl = $('log'), bar = $('bar'), runCard = $('runCard');
let evtSource = null, sceneTotal = 0, sceneDone = 0;

/**
 * The stamp every upload in this browser session is filed under. One per page
 * load, so references uploaded for an abandoned attempt do not accumulate under
 * a shared name - and a fresh page starts with a clean slate.
 */
let referenceStamp = Math.random().toString(36).slice(2, 10);

/** Reference media uploaded so far, as [{id, filename, kind, strength, startFrame}]. */
let references = [];

async function refreshHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    const pill = (ok, label) => `<span class="pill ${ok ? 'ok' : 'bad'}">${label}</span>`;
    let html =
      pill(h.backends?.comfy, 'ComfyUI MCP') +
      pill(h.backends?.ltx, 'LTX-Video') +
      pill(h.backends?.matting, 'Foreground matting') +
      pill(h.kokoro?.ok, 'Kokoro MCP') +
      pill(h.ffmpeg, 'ffmpeg') +
      (h.busy ? '<span class="pill busy">render in progress</span>' : '');
    if (h.hint) html += `<div class="hint">${h.hint}</div>`;
    if (!h.backends?.ltx && $('video-operation').value !== 'edit') {
      html += '<div class="hint">LTX-Video is not installed yet. Run ' +
        '<code>npm run setup:ltx</code> to render video diffusion locally ' +
        '(reference images and videos need it).</div>';
    }
    if (!h.backends?.matting) {
      html += '<div class="hint">Layered video edits need the local CPU foreground-matting runtime. ' +
        'Run <code>npm run setup:matting</code> once to enable it.</div>';
    }
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
        ${m.timeline ? ' · ' + m.timeline.durationInFrames + ' frames @ ' + m.timeline.fps + 'fps' : ''}
        ${m.backend?.cache?.hits ? ' · ' + m.backend.cache.hits + ' keyframe(s) cached' : ''}
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

/* ---------------------------------------------------------------------------
 * Reference uploads
 *
 * Files go straight to /api/references, which stores them under the local work
 * directory. Nothing is proxied anywhere, so a reference-conditioned render
 * stays entirely local. Each uploaded item carries the strength and start frame
 * the user chose, which is what LTX-Video consumes as a conditioning item.
 * ------------------------------------------------------------------------- */

function renderReferences() {
  const host = $('references');
  const fragment = document.createDocumentFragment();

  for (const reference of references) {
    const row = document.createElement('div');
    row.className = 'ref';

    const tag = document.createElement('span');
    tag.className = `tag ${reference.kind}`;
    tag.textContent = reference.kind;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = reference.filename;
    name.title = reference.path ?? reference.filename;

    const strengthLabel = document.createElement('span');
    strengthLabel.className = 'field';
    strengthLabel.textContent = 'strength';
    const strength = document.createElement('input');
    strength.type = 'number';
    strength.min = '0';
    strength.max = '1';
    strength.step = '0.05';
    strength.value = String(reference.strength);
    strength.title = 'How strictly the render follows this reference (0-1)';
    strength.addEventListener('change', () => {
      reference.strength = Math.min(1, Math.max(0, Number(strength.value) || 0));
      strength.value = String(reference.strength);
    });

    const frameLabel = document.createElement('span');
    frameLabel.className = 'field';
    frameLabel.textContent = 'frame';
    const frame = document.createElement('input');
    frame.type = 'number';
    frame.min = '0';
    frame.step = '1';
    frame.value = String(reference.startFrame);
    frame.title = 'Frame of the render this reference appears at';
    frame.disabled = reference.kind !== 'video';
    frame.addEventListener('change', () => {
      reference.startFrame = Math.max(0, Math.trunc(Number(frame.value) || 0));
      frame.value = String(reference.startFrame);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      references = references.filter((r) => r.id !== reference.id);
      renderReferences();
      // Ask the server to drop it too, so abandoned uploads do not pile up.
      try {
        await fetch(`/api/references?stamp=${encodeURIComponent(referenceStamp)}`, {
          method: 'DELETE',
        });
      } catch { /* the local list is already correct */ }
    });

    row.append(tag, name, strengthLabel, strength, frameLabel, frame, remove);
    fragment.appendChild(row);
  }

  host.replaceChildren(fragment);

  $('reference-status').textContent = references.length
    ? ($('video-operation').value === 'edit'
      ? 'The uploaded video will be segmented locally and composited with the requested themes.'
      : `${references.length} reference${references.length === 1 ? '' : 's'} will condition ` +
        `${$('reference-scope').value === 'all' ? 'every scene' : 'the first scene'}. ` +
        'Reference-conditioned rendering uses LTX-Video.')
    : '';
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) return;

  for (const file of files) {
    $('reference-status').textContent = `Uploading ${file.name}…`;
    try {
      const response = await fetch(`/api/references?stamp=${encodeURIComponent(referenceStamp)}`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || response.statusText);

      // The UI-wide strength/frame defaults apply to every upload unless the
      // user changes them per row.
      const defaultStrength = Number($('reference-strength').value) || 1;
      const defaultFrame = Math.max(0, Math.trunc(Number($('reference-start').value) || 0));
      references.push({
        id: data.id ?? data.path,
        path: data.path,
        filename: data.filename ?? file.name,
        kind: data.kind,
        strength: defaultStrength,
        // A still can only ever condition the first frame.
        startFrame: data.kind === 'video' ? defaultFrame : 0,
      });
    } catch (error) {
      window.alert(`Could not upload ${file.name}: ${error.message}`);
    }
  }

  renderReferences();
}

$('drop').addEventListener('click', () => $('reference-input').click());
$('reference-input').addEventListener('change', (event) => {
  uploadFiles(event.target.files);
  event.target.value = '';
});
['dragenter', 'dragover'].forEach((type) =>
  $('drop').addEventListener(type, (event) => {
    event.preventDefault();
    $('drop').classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((type) =>
  $('drop').addEventListener(type, (event) => {
    event.preventDefault();
    $('drop').classList.remove('over');
  }),
);
$('drop').addEventListener('drop', (event) => uploadFiles(event.dataTransfer?.files));
$('reference-scope').addEventListener('change', renderReferences);
$('video-operation').addEventListener('change', () => {
  const editing = $('video-operation').value === 'edit';
  $('edit-themes').classList.toggle('hidden', !editing);
  $('video-operation-help').textContent = editing
    ? 'Edit mode detects the moving foreground locally, generates the selected theme layers, and composites them while retaining the source video motion and duration.'
    : 'Edit mode segments the moving foreground locally, composites generated theme imagery behind/in place of it, and replaces source audio with generated narration.';
  renderReferences();
  refreshHealth();
});

async function generate() {
  const topic = $('topic').value.trim();
  if (!topic) { $('topic').focus(); return; }
  const body = {
    topic,
    resolution: $('resolution').value,
    voice: $('voice').value,
    backend: $('backend').value,
    transition: $('transition').value,
  };
  const scenes = Number($('scenes').value) || 0;
  if (scenes > 0) body.scenes = scenes;

  const ltxModel = $('ltx-model').value.trim();
  if (ltxModel) body.ltxModel = ltxModel;

  // References: the stamp tells the server which uploaded files to load, so the
  // browser never sends a local filesystem path it does not own.
  if (references.length > 0) {
    body.referenceStamp = referenceStamp;
    body.referenceScope = $('reference-scope').value;
    body.references = references.map((r) => ({
      path: r.path,
      strength: r.strength,
      startFrame: r.startFrame,
    }));
  }
  body.editVideo = $('video-operation').value === 'edit';
  if (body.editVideo) {
    body.backgroundTheme = $('background-theme').value.trim();
    body.foregroundTheme = $('foreground-theme').value.trim();
  }
  if (body.editVideo && references.filter((reference) => reference.kind === 'video').length !== 1) {
    runCard.classList.remove('hidden');
    logEl.replaceChildren();
    appendLog('error', 'Edit mode needs exactly one uploaded video. Remove extra videos or switch to reference mode.');
    return;
  }

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
    if (body.editVideo) {
      appendLog('info', 'Segmenting and compositing video themes locally; ComfyUI generates theme artwork');
    } else if (references.length) {
      appendLog('info', `${references.length} reference(s) conditioning this render`);
    }
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
      else if (e.type === 'timeline') {
        appendLog(
          'info',
          `timeline locked: ${e.timeline.durationInFrames} frames @ ${e.timeline.fps}fps ` +
            `(${e.timeline.durationSeconds.toFixed(1)}s, ${e.timeline.mode})`,
        );
      } else if (e.type === 'scene-done') {
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
renderReferences();
setInterval(refreshRuns, 30000);
