// Thin client for the Higgsfield platform API (https://api.higgsfield.ai).
//
// Request shape, auth header, upload flow and status polling follow the official
// @higgsfield/client v2 SDK:
//   POST /{model endpoint}                 -> { request_id, status, ... }
//   GET  /requests/{request_id}/status     -> { status, video: { url }, images: [...] }
//   POST /requests/{request_id}/cancel
//   POST /files/generate-upload-url        -> { upload_url, public_url }, then PUT bytes to upload_url
// Auth: "Authorization: Key KEY_ID:KEY_SECRET"

import { readFile } from 'node:fs/promises';

export const API_BASE = 'https://api.higgsfield.ai';

export const ACTIVE = new Set(['queued', 'in_progress']);
export const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);

// Both Genjutsu models share the same input schema:
//   { prompt?: string, video_url: uri, image_urls: uri[1..8], resolution: "720p" | "480p" }
// Pricing is per second of INPUT video, rounded up to the next whole second (list price, before discounts).
export const MODELS = {
  'object-swap': {
    id: 'object-swap',
    name: 'Genjutsu Object Swap',
    endpoint: 'higgsfield/genjutsu/object-swap/v1.0',
    blurb: 'Swap specific people/objects in the video for the ones in your reference images. Everything else stays.',
    ratePerSecond: { '480p': 0.318, '720p': 0.681 },
  },
  'motion-transfer': {
    id: 'motion-transfer',
    name: 'Genjutsu Motion Transfer',
    endpoint: 'higgsfield/genjutsu/motion-transfer/v1.0',
    blurb: 'Re-imagine the whole clip (characters, location, style) from your references, keeping the original motion and camera.',
    ratePerSecond: { '480p': 0.318, '720p': 0.681 },
  },
};

export const RESOLUTIONS = ['720p', '480p'];
export const MAX_IMAGES = 8;

export const UPLOAD_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
};

export class HiggsfieldError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const HINTS = {
  401: 'check your API key',
  402: 'not enough credits',
  403: 'key lacks access or request was blocked',
  404: 'unknown model endpoint',
  422: 'invalid parameters',
  429: 'rate limited, wait and retry',
};

export function estimateCost(modelId, resolution, durationSeconds) {
  const model = MODELS[modelId];
  if (!model || !model.ratePerSecond[resolution] || !(durationSeconds > 0)) return null;
  const billedSeconds = Math.ceil(durationSeconds);
  return { billedSeconds, usd: +(billedSeconds * model.ratePerSecond[resolution]).toFixed(3) };
}

export function readCredentials(env = process.env) {
  const combined = (env.HF_CREDENTIALS || env.HIGGSFIELD_API_KEY || '').trim();
  if (combined.includes(':')) return combined;
  const id = (env.HF_API_KEY_ID || env.HF_API_KEY || '').trim();
  const secret = (env.HF_API_KEY_SECRET || env.HF_API_SECRET || '').trim();
  return id && secret ? `${id}:${secret}` : null;
}

export function outputUrls(response) {
  // Collect every { url } in the response except the *_url bookkeeping fields (status_url, cancel_url).
  const urls = [];
  for (const [key, value] of Object.entries(response || {})) {
    if (key.endsWith('_url')) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === 'object' && typeof item.url === 'string') urls.push(item.url);
    }
  }
  return [...new Set(urls)];
}

export function createClient({ credentials, baseURL = API_BASE, fetchImpl = fetch }) {
  async function api(method, path, body) {
    if (!credentials) throw new HiggsfieldError('No Higgsfield API key configured (set HF_CREDENTIALS in .env)', 401);
    const headers = {
      Authorization: `Key ${credentials}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(baseURL + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // never forward the key to another host
      });
    } catch (err) {
      throw new HiggsfieldError(`Network error on ${method} ${path}: ${err.message}`);
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      let detail = data.detail ?? data.error ?? data.message ?? '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
      const hint = HINTS[res.status] ? ` (${HINTS[res.status]})` : '';
      throw new HiggsfieldError(`HTTP ${res.status} on ${method} ${path}${hint}${detail ? `: ${detail.slice(0, 400)}` : ''}`, res.status);
    }
    return data;
  }

  return {
    async uploadFile(filePath, contentType) {
      const slot = await api('POST', '/files/generate-upload-url', { content_type: contentType });
      if (!slot.upload_url || !slot.public_url) throw new HiggsfieldError('Upload slot response had no upload_url/public_url');
      const headers = { 'Content-Type': contentType };
      for (const [k, v] of Object.entries(slot.upload_headers || {})) {
        if (!['authorization', 'cookie', 'host'].includes(k.toLowerCase())) headers[k] = String(v);
      }
      // The presigned storage URL never receives the API key.
      const res = await fetchImpl(slot.upload_url, { method: 'PUT', headers, body: await readFile(filePath) });
      if (!res.ok) throw new HiggsfieldError(`Upload to storage failed: HTTP ${res.status}`, res.status);
      return slot.public_url;
    },
    submit(endpoint, input) {
      return api('POST', `/${endpoint}`, input);
    },
    status(requestId) {
      return api('GET', `/requests/${encodeURIComponent(requestId)}/status`);
    },
    cancel(requestId) {
      return api('POST', `/requests/${encodeURIComponent(requestId)}/cancel`);
    },
  };
}

// Offline stand-in for trying the UI without spending credits. Jobs "complete" after ~12s
// and return the uploaded reference video as the result.
export function createMockClient({ publicBase }) {
  const jobs = new Map();
  return {
    async uploadFile(filePath) {
      return `${publicBase}/uploads/${filePath.split(/[\\/]/).pop()}`;
    },
    async submit(endpoint, input) {
      const request_id = crypto.randomUUID();
      jobs.set(request_id, { started: Date.now(), input, canceled: false });
      return { request_id, status: 'queued' };
    },
    async status(requestId) {
      const job = jobs.get(requestId);
      if (!job) throw new HiggsfieldError('Unknown request (mock server restarted?)', 404);
      if (job.canceled) return { request_id: requestId, status: 'canceled' };
      const elapsed = Date.now() - job.started;
      if (elapsed < 4000) return { request_id: requestId, status: 'queued' };
      if (elapsed < 12000) return { request_id: requestId, status: 'in_progress' };
      return { request_id: requestId, status: 'completed', video: { url: job.input.video_url } };
    },
    async cancel(requestId) {
      const job = jobs.get(requestId);
      if (job) job.canceled = true;
      return { request_id: requestId, status: 'canceled' };
    },
  };
}
