# Video AI — processing server (the AI brain)

This server does REAL AI captioning: it receives a video from the app,
transcribes the speech with AssemblyAI's AI, and burns the captions onto
the video with ffmpeg. It powers the "Caption generator" and "Subtitle
generator" tools, and its transcription engine is the foundation for the
reel maker, shorts, memes, and summarizer later.

## Make it live (about 30 minutes, both have free tiers)

1. **AssemblyAI account** (powers 6 tools: captions, subtitles, reels, shorts, memes, summarizer) — sign up free at assemblyai.com, copy your API
   key from the dashboard. Free credits included; after that roughly
   $0.12 per audio hour (a 5-minute video costs you about 1 cent).
   NEVER paste this key into code or share it with anyone.

2. **Deploy this folder** — easiest is Render (render.com, free tier):
   - Push this folder to a GitHub repository
   - In Render: New → Web Service → connect the repo
   - Render detects the Dockerfile automatically (it installs ffmpeg)
   - Under Environment, add: ASSEMBLYAI_API_KEY = your key
   - Deploy. You get a URL like https://video-ai-backend.onrender.com

3. **Connect the app** — in the app's `src/config.js`, set:
   BACKEND_URL = "https://your-service.onrender.com"
   The Caption and Subtitle tools now do real AI processing.

## Test it without the app

curl -F "video=@some_video.mp4" https://your-service.onrender.com/api/jobs
→ returns {"jobId":"..."}; then poll:
curl https://your-service.onrender.com/api/jobs/THE_ID
→ when status is "done", download from resultUrl.

## Scaling notes (for when users grow)

- The job queue is in-memory: perfect for launch, swap to Redis + multiple
  workers when you pass ~thousands of videos/day (the code is structured
  so only the queue changes).
- Free-tier hosts sleep when idle (first request is slow) and have small
  disks — upgrade the instance when real users arrive.
- Store results in cloud storage (S3/GCS) + CDN instead of the local
  results/ folder at scale.

## Tool coverage (v2)

| Tool | Engine | Key needed |
|---|---|---|
| Captions, Subtitles | AssemblyAI + ffmpeg | ASSEMBLYAI_API_KEY |
| Reel maker, Shorts | AI highlight detection + cutting | ASSEMBLYAI_API_KEY |
| Meme generator | AI sentiment analysis + cutting | ASSEMBLYAI_API_KEY |
| Summarizer | AI chapter detection + stitching | ASSEMBLYAI_API_KEY |
| AI editor | ffmpeg precise cutting | none (free) |
| Noise remover | ffmpeg noise filter | none (free) |
| Enhancer | upscale + sharpen + color | none (free) |
| Talking avatar | D-ID API (d-id.com) | DID_API_KEY (paid per video) |
| AI video creator | Luma Dream Machine (lumalabs.ai) | LUMA_API_KEY (paid per video) |

Check what's live anytime: GET /health shows which keys are configured.

Honest notes: the meme finder uses sentiment analysis (liveliest positive
moments) — a solid v1, not true humor understanding. The enhancer is
classical sharpening/upscaling — good visible improvement, not neural
super-resolution (that can be a premium upgrade later). Avatar and creator
are the expensive tools: D-ID and Luma charge per generated video, so
check their pricing before enabling and consider pricing those tools
higher in the app.
