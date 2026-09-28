import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, estimateCost, outputUrls, readCredentials } from '../lib/higgsfield.js';

test('estimateCost rounds input seconds up and uses the per-resolution rate', () => {
  assert.deepEqual(estimateCost('object-swap', '720p', 15), { billedSeconds: 15, usd: 10.215 });
  assert.deepEqual(estimateCost('object-swap', '480p', 14.2), { billedSeconds: 15, usd: 4.77 });
  assert.equal(estimateCost('object-swap', '1080p', 15), null);
  assert.equal(estimateCost('nope', '720p', 15), null);
});

test('readCredentials accepts combined or split keys', () => {
  assert.equal(readCredentials({ HF_CREDENTIALS: 'id:secret' }), 'id:secret');
  assert.equal(readCredentials({ HF_API_KEY_ID: 'id', HF_API_KEY_SECRET: 'secret' }), 'id:secret');
  assert.equal(readCredentials({}), null);
});

test('outputUrls collects media urls but skips status/cancel urls', () => {
  const urls = outputUrls({
    status: 'completed',
    status_url: 'https://api.higgsfield.ai/requests/x/status',
    video: { url: 'https://cdn/x.mp4' },
    images: [{ url: 'https://cdn/a.jpg' }, { url: 'https://cdn/x.mp4' }],
  });
  assert.deepEqual(urls, ['https://cdn/x.mp4', 'https://cdn/a.jpg']);
});

test('client sends Key auth to the API but not to the presigned upload url', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/files/generate-upload-url')) {
      return new Response(JSON.stringify({ upload_url: 'https://storage/put', public_url: 'https://cdn/file.mp4' }));
    }
    if (url === 'https://storage/put') return new Response('');
    return new Response(JSON.stringify({ request_id: 'abc', status: 'queued' }));
  };
  const client = createClient({ credentials: 'id:secret', fetchImpl });
  const url = await client.uploadFile(new URL(import.meta.url).pathname, 'video/mp4');
  assert.equal(url, 'https://cdn/file.mp4');
  const res = await client.submit('higgsfield/genjutsu/object-swap/v1.0', { video_url: url, image_urls: [url], resolution: '720p' });
  assert.equal(res.request_id, 'abc');

  assert.equal(calls[0].opts.headers.Authorization, 'Key id:secret');
  assert.equal(calls[1].opts.method, 'PUT');
  assert.equal(calls[1].opts.headers.Authorization, undefined);
  assert.equal(calls[2].url, 'https://api.higgsfield.ai/higgsfield/genjutsu/object-swap/v1.0');
  assert.equal(JSON.parse(calls[2].opts.body).resolution, '720p');
});

test('client surfaces API errors with a hint', async () => {
  const client = createClient({
    credentials: 'id:secret',
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Not enough credits' }), { status: 402 }),
  });
  await assert.rejects(client.status('r1'), /HTTP 402.*not enough credits.*Not enough credits/);
});
