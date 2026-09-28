# Lobby Swap

A small local web app for making "Hotel Lobby"-style swap videos with **Higgsfield Genjutsu** through the
Higgsfield **API** (pay-per-use API credits) instead of the web app subscription.

You upload a reference clip and one photo per person. The app uploads them to Higgsfield, shows the
price and asks you to confirm, then submits the job, tracks it, and saves the finished video to `outputs/`.

## Setup

Requires Node.js 18.17 or newer.

```bash
npm install
cp .env.example .env        # then paste your key into HF_CREDENTIALS=KEY_ID:KEY_SECRET
npm start                   # open http://localhost:5173
```

Get an API key at [console.higgsfield.ai](https://console.higgsfield.ai). The key only lives in `.env`, which git ignores.
The server listens only on `127.0.0.1`, and the browser never sees the key.

**Try it for free first:** `npm run mock` runs the whole flow with every Higgsfield call faked. No credits are spent.
The "result" is just your input video.

## How it works

| Step | Call | Billed? |
|---|---|---|
| Upload video and images | `POST /files/generate-upload-url`, then `PUT` to the presigned URL | no |
| Submit | `POST /higgsfield/genjutsu/object-swap/v1.0` (or `motion-transfer`) | **yes** |
| Poll | `GET /requests/{id}/status` | no |
| Cancel (only while queued) | `POST /requests/{id}/cancel` | refunds |

Request body (both Genjutsu models use the same schema):

```json
{
  "prompt": "Replace the man at the front desk with the person from image 1. …",
  "video_url": "https://…/lobby.mp4",
  "image_urls": ["https://…/person1.jpg", "https://…/person2.jpg"],
  "resolution": "720p"
}
```

- `image_urls`: 1–8 images. `resolution`: `720p` (default) or `480p`. `prompt`: optional, up to 10,000 characters.
- **Price** is per second of *input* video, rounded up: **$0.681/s at 720p**, $0.318/s at 480p (list price).
  So a 15s clip at 720p is about **$10.22**. Failed or moderated jobs are refunded.
- Every job is saved to `data/jobs.json` as soon as Higgsfield returns a `request_id`, so a paid job is never lost
  if you close the tab or restart the server. If a submit fails with a network error, the job is marked
  "Check console" and **not** retried automatically, so you're never charged twice.

## Tips

- **The video must be MP4.** Convert a `.mov` with `ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4`.
  Use H.264 for iPhone HEVC clips too. Some browsers can't read HEVC length at all.
- Use clear, front-facing, well-lit photos. You can add a second angle of the same person. Just mention both
  image numbers in the prompt.
- Try **480p first** (less than half the price) to check the swap lands on the right people. Then re-run at 720p.
- **Object Swap** keeps everything except the people you name. **Motion Transfer** re-imagines the whole clip
  from your references and keeps only motion and camera.

## Development

```bash
npm test          # unit tests for the API client (no network)
npm run mock      # UI with a fake backend
```

Source of the API details: the official [`@higgsfield/client`](https://www.npmjs.com/package/@higgsfield/client) SDK
(auth, upload, polling) and the model's API reference at
`https://open.higgsfield.ai/models/higgsfield/genjutsu/object-swap/v1.0/api-reference` (schema and pricing).
