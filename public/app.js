const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  video: null, // File
  duration: null,
  people: [], // { file, url, replaces }
  model: 'object-swap',
  resolution: '720p',
  promptTouched: false,
};

const ACTIVE = new Set(['pending', 'uploading', 'submitting', 'queued', 'in_progress']);
const STATUS_LABEL = {
  pending: 'Starting',
  uploading: 'Uploading',
  submitting: 'Submitting',
  queued: 'Queued',
  in_progress: 'Generating',
  completed: 'Done',
  failed: 'Failed',
  nsfw: 'Moderated',
  canceled: 'Canceled',
  rejected: 'Rejected',
  upload_failed: 'Upload failed',
  unknown: 'Check console',
};

const money = (n) => `$${(Math.round(n * 100 + 1e-6) / 100).toFixed(2)}`;

// ---------- config ----------

async function loadConfig() {
  state.config = await (await fetch('/api/config')).json();
  const badge = $('#modeBadge');
  if (state.config.mock) {
    badge.textContent = 'Mock mode · no credits spent';
    badge.className = 'badge warn';
  } else if (state.config.configured) {
    badge.textContent = 'Live · API key loaded';
    badge.className = 'badge ok';
  } else {
    badge.textContent = 'No API key — see README';
    badge.className = 'badge bad';
  }

  $('#models').innerHTML = state.config.models
    .map(
      (m) => `
      <label class="choice">
        <input type="radio" name="model" value="${m.id}" ${m.id === state.model ? 'checked' : ''}>
        <span><strong>${m.name}</strong><small>${m.blurb}</small></span>
      </label>`,
    )
    .join('');
  $('#models').addEventListener('change', (e) => {
    state.model = e.target.value;
    render();
  });

  $('#resolutions').innerHTML = state.config.resolutions
    .map((r) => `<label><input type="radio" name="res" value="${r}" ${r === state.resolution ? 'checked' : ''}><span>${r}</span></label>`)
    .join('');
  $('#resolutions').addEventListener('change', (e) => {
    state.resolution = e.target.value;
    render();
  });
}

// ---------- video ----------

function setVideo(file) {
  if (!file) return;
  if (file.type !== 'video/mp4') {
    showError('Reference video must be an MP4. Convert a .mov with: ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4');
    return;
  }
  showError('');
  state.video = file;
  state.duration = null;
  const el = $('#videoPreview');
  el.src = URL.createObjectURL(file);
  el.hidden = false;
  $('#videoDrop').classList.add('filled');
  $('#durationFallback').hidden = true;
  $('#videoMeta').textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
  el.onerror = () => {
    if (state.duration) return; // metadata already read; a later decode error doesn't matter here
    $('#durationFallback').hidden = false;
    render();
  };
  el.onloadedmetadata = () => {
    if (!Number.isFinite(el.duration)) return el.onerror();
    $('#durationFallback').hidden = true;
    state.duration = el.duration;
    $('#videoMeta').textContent = `${file.name} · ${el.duration.toFixed(2)}s · ${el.videoWidth}×${el.videoHeight} · ${(file.size / 1e6).toFixed(1)} MB`;
    render();
  };
  render();
}

$('#durationInput').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  state.duration = v > 0 ? v : null;
  render();
});

$('#videoInput').addEventListener('change', (e) => setVideo(e.target.files[0]));
setupDrop($('#videoDrop'), (files) => setVideo(files[0]));

// ---------- people ----------

function addPerson(file) {
  if (state.people.length >= state.config.maxImages) return;
  state.people.push({ file: null, url: null, replaces: '' });
  if (file) setPersonFile(state.people.length - 1, file);
  renderPeople();
  render();
}

function setPersonFile(i, file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    showError('Images must be JPG, PNG or WEBP.');
    return;
  }
  showError('');
  state.people[i].file = file;
  state.people[i].url = URL.createObjectURL(file);
}

function renderPeople() {
  const root = $('#people');
  root.innerHTML = '';
  state.people.forEach((p, i) => {
    const node = $('#personTpl').content.firstElementChild.cloneNode(true);
    const img = node.querySelector('img');
    node.querySelector('.tag').textContent = `Image ${i + 1}`;
    if (p.url) {
      img.src = p.url;
      img.hidden = false;
      node.querySelector('.thumb-empty').hidden = true;
    }
    const fileInput = node.querySelector('input[type=file]');
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) setPersonFile(i, e.target.files[0]);
      renderPeople();
      render();
    });
    setupDrop(node.querySelector('.thumb'), (files) => {
      setPersonFile(i, files[0]);
      renderPeople();
      render();
    });
    const replaces = node.querySelector('.replaces');
    replaces.value = p.replaces;
    replaces.addEventListener('input', (e) => {
      p.replaces = e.target.value;
      if (!state.promptTouched) $('#prompt').value = buildPrompt();
    });
    node.querySelector('.remove').addEventListener('click', () => {
      state.people.splice(i, 1);
      renderPeople();
      render();
    });
    root.appendChild(node);
  });
  $('#addPerson').hidden = state.people.length >= state.config.maxImages;
  if (!state.promptTouched) $('#prompt').value = buildPrompt();
}

$('#addPerson').addEventListener('click', () => addPerson());

// ---------- prompt ----------

function buildPrompt() {
  const lines = state.people
    .map((p, i) => (p.replaces.trim() ? `Replace ${p.replaces.trim()} with the person from image ${i + 1}.` : null))
    .filter(Boolean);
  if (!lines.length) return '';
  lines.push(
    "Keep each person's face, hair and outfit from their reference image. Keep the setting, lighting, camera movement, timing and everyone else in the video exactly as in the original.",
  );
  return lines.join(' ');
}

$('#prompt').addEventListener('input', () => {
  state.promptTouched = $('#prompt').value.trim() !== '';
});
$('#rebuildPrompt').addEventListener('click', () => {
  state.promptTouched = false;
  $('#prompt').value = buildPrompt();
});

// ---------- cost + submit ----------

function estimate() {
  if (!state.duration || !state.config) return null;
  const model = state.config.models.find((m) => m.id === state.model);
  const rate = model.ratePerSecond[state.resolution];
  const seconds = Math.ceil(state.duration);
  return { seconds, rate, usd: +(seconds * rate).toFixed(3) };
}

function render() {
  const est = estimate();
  $('#costValue').textContent = est ? money(est.usd) : '—';
  $('#costDetail').textContent = est
    ? `${est.seconds}s billed × $${est.rate}/s at ${state.resolution} (list price, before promo credit-back)`
    : 'Add a video to see the price.';
  const ready = state.video && state.duration && state.people.some((p) => p.file) && state.config?.configured;
  $('#generate').disabled = !ready;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const est = estimate();
  if (!est) return;
  const imgs = state.people.filter((p) => p.file);
  const modelName = state.config.models.find((m) => m.id === state.model).name;
  $('#confirmText').innerHTML = `<strong>${modelName}</strong> at <strong>${state.resolution}</strong> on a ${state.duration.toFixed(
    1,
  )}s clip with ${imgs.length} reference image${imgs.length > 1 ? 's' : ''}.<br>Estimated charge: <strong>${money(est.usd)}</strong>${
    state.config.mock ? ' <em>(mock mode: nothing is charged)</em>' : ''
  }`;
  const dialog = $('#confirm');
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener(
    'close',
    async () => {
      if (dialog.returnValue === 'ok') await submit(est);
    },
    { once: true },
  );
});

async function submit(est) {
  showError('');
  const btn = $('#generate');
  btn.disabled = true;
  btn.textContent = 'Sending files…';
  const body = new FormData();
  body.append('video', state.video);
  state.people.filter((p) => p.file).forEach((p) => body.append('images', p.file));
  body.append('model', state.model);
  body.append('resolution', state.resolution);
  body.append('prompt', $('#prompt').value.trim());
  body.append('name', $('#name').value.trim());
  body.append('duration', String(state.duration));
  body.append('confirmedUsd', String(est.usd));
  try {
    const res = await fetch('/api/jobs', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadJobs();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.textContent = 'Generate';
    render();
  }
}

function showError(msg) {
  $('#formError').textContent = msg;
}

// ---------- jobs ----------

let jobs = [];

async function loadJobs() {
  jobs = await (await fetch('/api/jobs')).json();
  renderJobs();
}

async function pollActive() {
  const active = jobs.filter((j) => ACTIVE.has(j.status));
  for (const job of active) {
    try {
      const fresh = await (await fetch(`/api/jobs/${job.id}`)).json();
      Object.assign(job, fresh);
    } catch {
      /* try again next tick */
    }
  }
  if (active.length) renderJobs();
}
setInterval(pollActive, 4000);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderJobs() {
  const root = $('#jobs');
  if (!jobs.length) {
    root.innerHTML = '<p class="empty">Nothing yet. Your renders show up here, and stay here after a restart.</p>';
    return;
  }
  root.innerHTML = jobs
    .map((j) => {
      const model = state.config.models.find((m) => m.id === j.model)?.name || j.model;
      const result = j.localFiles?.[0] || j.outputs?.[0];
      const links = [...(j.localFiles || []), ...(j.localFiles?.length ? [] : j.outputs || [])];
      return `
      <article class="job ${esc(j.status)}">
        <div class="job-head">
          <strong>${esc(j.name)}</strong>
          <span class="pill ${esc(j.status)}">${ACTIVE.has(j.status) ? '<i class="spin"></i>' : ''}${esc(STATUS_LABEL[j.status] || j.status)}</span>
        </div>
        <div class="meta">${esc(model)} · ${esc(j.resolution)} · ${j.durationSeconds?.toFixed?.(1) ?? '?'}s · ~${money(j.estimate?.usd || 0)}${
          j.mock ? ' · mock' : ''
        }</div>
        ${result && j.status === 'completed' ? `<video src="${esc(result)}" controls playsinline loop></video>` : `
          <div class="job-refs">
            <video src="${esc(j.preview?.video)}" muted playsinline></video>
            ${(j.preview?.images || []).map((src) => `<img src="${esc(src)}" alt="">`).join('')}
          </div>`}
        <p class="job-msg">${esc(j.message)}</p>
        <div class="job-actions">
          ${links.map((u, i) => `<a href="${esc(u)}" download target="_blank" rel="noopener">Download${links.length > 1 ? ` ${i + 1}` : ''}</a>`).join('')}
          ${j.status === 'queued' ? `<button class="link" data-cancel="${j.id}">Cancel</button>` : ''}
          ${j.requestId ? `<span class="rid" title="Higgsfield request id">${esc(j.requestId)}</span>` : ''}
        </div>
      </article>`;
    })
    .join('');
}

$('#jobs').addEventListener('click', async (e) => {
  const id = e.target.dataset?.cancel;
  if (!id) return;
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) alert(data.error);
  await loadJobs();
});

// ---------- drag & drop helper ----------

function setupDrop(el, onFiles) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
}

// ---------- boot ----------

await loadConfig();
addPerson();
addPerson();
await loadJobs();
render();
