import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE,
  MAX_IMAGES,
  MODELS,
  RESOLUTIONS,
  UPLOAD_TYPES,
  createClient,
  createMockClient,
  estimateCost,
  outputUrls,
  readCredentials,
} from './lib/higgsfield.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'outputs');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const MOCK = process.env.HF_MOCK === '1' || process.env.HF_MOCK === 'true';
const credentials = readCredentials();

const hf = MOCK
  ? createMockClient({ publicBase: `http://localhost:${PORT}` })
  : createClient({ credentials });

await Promise.all([DATA_DIR, UPLOAD_DIR, OUTPUT_DIR].map((d) => mkdir(d, { recursive: true })));

// ---------- job store (a JSON file, so a paid request_id is never lost on restart) ----------

let jobs = [];
try {
  jobs = JSON.parse(await readFile(JOBS_FILE, 'utf8'));
} catch {
  jobs = [];
}
// Jobs interrupted by a restart mid-pipeline: uploads can simply be redone, but a submit
// without a saved request_id might still have been charged.
for (const job of jobs) {
  if (['pending', 'uploading'].includes(job.status)) {
    Object.assign(job, { status: 'upload_failed', message: 'Interrupted by a server restart before submitting. Nothing was charged.' });
  } else if (job.status === 'submitting') {
    Object.assign(job, { status: 'unknown', message: 'Server stopped while submitting. Check your Higgsfield console before retrying.' });
  }
}

let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    const tmp = `${JOBS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(jobs, null, 2));
    await rename(tmp, JOBS_FILE);
  });
  return saving;
}

function update(job, fields) {
  Object.assign(job, fields, { updatedAt: new Date().toISOString() });
  return save();
}

const findJob = (id) => jobs.find((j) => j.id === id);

// ---------- pipeline: upload refs -> submit (billable) -> poll -> download ----------

async function runJob(job, files) {
  try {
    await update(job, { status: 'uploading', message: 'Uploading reference video…' });
    const videoUrl = await hf.uploadFile(files.video.path, files.video.mimetype);
    const imageUrls = [];
    for (const [i, img] of files.images.entries()) {
      await update(job, { message: `Uploading image ${i + 1} of ${files.images.length}…` });
      imageUrls.push(await hf.uploadFile(img.path, img.mimetype));
    }
    job.input = { prompt: job.prompt, video_url: videoUrl, image_urls: imageUrls, resolution: job.resolution };
    await update(job, { message: 'Uploads done.' });
  } catch (err) {
    await update(job, { status: 'upload_failed', message: err.message });
    return;
  }

  // From here on the request may be billed.
  await update(job, { status: 'submitting', message: 'Submitting to Higgsfield…' });
  let result;
  try {
    result = await hf.submit(MODELS[job.model].endpoint, job.input);
  } catch (err) {
    const definite = err.status >= 400 && err.status < 500;
    await update(job, {
      status: definite ? 'rejected' : 'unknown',
      message: definite
        ? err.message
        : `${err.message}. The submit may or may not have gone through — check your Higgsfield console before retrying so you are not charged twice.`,
    });
    return;
  }
  if (!result.request_id) {
    await update(job, { status: 'unknown', message: 'Higgsfield accepted the request but returned no request_id. Check your console.', response: result });
    return;
  }
  await update(job, {
    requestId: result.request_id,
    status: ACTIVE.has(result.status) ? result.status : 'queued',
    message: 'Submitted. Waiting in queue…',
    response: result,
  });
}

const lastPoll = new Map();

async function refresh(job) {
  if (!job.requestId || !ACTIVE.has(job.status)) return job;
  const now = Date.now();
  if (now - (lastPoll.get(job.id) || 0) < 3000) return job;
  lastPoll.set(job.id, now);
  try {
    const res = await hf.status(job.requestId);
    const status = res.status || job.status;
    const messages = {
      queued: 'Queued at Higgsfield…',
      in_progress: 'Generating… (this can take several minutes)',
      completed: 'Done!',
      failed: 'Generation failed. Higgsfield refunds credits for failed jobs.',
      nsfw: 'Rejected by content moderation. Higgsfield refunds credits for these.',
      canceled: 'Canceled.',
    };
    await update(job, { status, response: res, message: messages[status] || `Status: ${status}`, outputs: outputUrls(res) });
    if (status === 'completed') downloadOutputs(job);
  } catch (err) {
    await update(job, { message: `Status check failed (will retry): ${err.message}` });
  }
  return job;
}

async function downloadOutputs(job) {
  if (job.localFiles?.length || !job.outputs?.length || MOCK) return;
  const dir = path.join(OUTPUT_DIR, job.id);
  await mkdir(dir, { recursive: true });
  const localFiles = [];
  for (const [i, url] of job.outputs.entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let ext = path.extname(new URL(url).pathname).toLowerCase();
      if (!/^\.[a-z0-9]{2,5}$/.test(ext)) ext = res.headers.get('content-type')?.includes('mp4') ? '.mp4' : '.bin';
      const name = `${job.name || 'output'}-${i + 1}${ext}`.replace(/[^\w.-]+/g, '_');
      await pipeline(Readable.fromWeb(res.body), createWriteStream(path.join(dir, name)));
      localFiles.push(`/outputs/${job.id}/${name}`);
    } catch (err) {
      console.warn(`Could not save output ${url}: ${err.message}`);
    }
  }
  await update(job, { localFiles });
}

// ---------- http ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4' }[file.mimetype];
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: MAX_IMAGES + 1 },
  fileFilter: (_req, file, cb) => {
    const kind = UPLOAD_TYPES[file.mimetype];
    const expected = file.fieldname === 'video' ? 'video' : 'image';
    if (kind !== expected) {
      cb(new Error(file.fieldname === 'video'
        ? `Reference video must be an MP4 (got ${file.mimetype}). Convert .mov with: ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4`
        : `Images must be JPG, PNG or WEBP (got ${file.mimetype}).`));
    } else cb(null, true);
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/outputs', express.static(OUTPUT_DIR));

app.get('/api/config', (_req, res) => {
  res.json({ configured: MOCK || Boolean(credentials), mock: MOCK, models: Object.values(MODELS), resolutions: RESOLUTIONS, maxImages: MAX_IMAGES });
});

app.get('/api/jobs', (_req, res) => {
  res.json([...jobs].reverse());
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(await refresh(job));
});

app.post(
  '/api/jobs',
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'images', maxCount: MAX_IMAGES }]),
  async (req, res) => {
    const { model = 'object-swap', resolution = '720p', prompt = '', name = '' } = req.body;
    const duration = Number(req.body.duration);
    const video = req.files?.video?.[0];
    const images = req.files?.images || [];

    if (!MOCK && !credentials) return res.status(400).json({ error: 'No API key configured. Add HF_CREDENTIALS to .env and restart.' });
    if (!MODELS[model]) return res.status(400).json({ error: `Unknown model ${model}` });
    if (!RESOLUTIONS.includes(resolution)) return res.status(400).json({ error: `Resolution must be one of ${RESOLUTIONS.join(', ')}` });
    if (!video) return res.status(400).json({ error: 'Add a reference video.' });
    if (images.length < 1) return res.status(400).json({ error: 'Add at least one reference image.' });
    if (prompt.length > 10000) return res.status(400).json({ error: 'Prompt is limited to 10,000 characters.' });

    const estimate = estimateCost(model, resolution, duration);
    if (!estimate) return res.status(400).json({ error: 'Could not read the video duration.' });
    // The UI shows the price and the user confirms it; refuse if what they confirmed doesn't match.
    if (Number(req.body.confirmedUsd) !== estimate.usd) {
      return res.status(409).json({ error: `Price confirmation mismatch (expected $${estimate.usd}).` });
    }

    const job = {
      id: randomUUID(),
      name: name.trim().slice(0, 80) || `lobby-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`,
      model,
      resolution,
      prompt,
      durationSeconds: duration,
      estimate,
      mock: MOCK,
      preview: { video: `/uploads/${video.filename}`, images: images.map((i) => `/uploads/${i.filename}`) },
      status: 'pending',
      message: 'Starting…',
      createdAt: new Date().toISOString(),
    };
    jobs.push(job);
    await save();
    res.status(202).json(job);
    runJob(job, { video, images });
  },
);

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = findJob(req.params.id);
  if (!job?.requestId) return res.status(404).json({ error: 'Not found' });
  try {
    await hf.cancel(job.requestId);
    lastPoll.delete(job.id);
    res.json(await refresh(job));
  } catch (err) {
    res.status(400).json({ error: `${err.message} (only queued jobs can be canceled)` });
  }
});

app.post('/api/jobs/:id/save', async (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  await downloadOutputs(job);
  res.json(job);
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Lobby Swap is running at http://localhost:${PORT}`);
  if (MOCK) console.log('  MOCK MODE: no Higgsfield calls are made and no credits are spent.');
  else if (!credentials) console.log('  ⚠ No API key found. Copy .env.example to .env and set HF_CREDENTIALS.');
  console.log('');
});
