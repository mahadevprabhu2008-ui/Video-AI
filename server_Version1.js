// Video AI — processing server (the "brain") v2: ALL TOOLS
//
// Real pipelines:
//   captions / subtitles  -> AssemblyAI transcription + ffmpeg burn
//   reels / shorts        -> AI highlight detection -> cut best 60s / 30s clips
//   memes                 -> AI sentiment analysis -> cut the funniest/liveliest moments
//   summary               -> AI chapter detection -> stitch a short summary video
//   editor                -> precise trim/cut (start & end seconds)
//   denoise               -> background noise removal (ffmpeg afftdn filter)
//   enhance               -> upscale + sharpen + color boost
//   avatar                -> D-ID API: photo + script -> talking video   (needs DID_API_KEY)
//   create                -> Luma AI API: text prompt -> generated video (needs LUMA_API_KEY)
//
// KEYS (set as environment variables on your host - never in code):
//   ASSEMBLYAI_API_KEY  required for captions/subtitles/reels/shorts/memes/summary
//   DID_API_KEY         required for avatar        (d-id.com)
//   LUMA_API_KEY        required for create        (lumalabs.ai)

const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const DID_KEY = process.env.DID_API_KEY;
const LUMA_KEY = process.env.LUMA_API_KEY;
const PORT = process.env.PORT || 3000;
const AAI = "https://api.assemblyai.com/v2";

const WORK = path.join(__dirname, "work");
const RESULTS = path.join(__dirname, "results");
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(RESULTS, { recursive: true });

const upload = multer({ dest: WORK, limits: { fileSize: 500 * 1024 * 1024 } });
const app = express();
app.use("/results", express.static(RESULTS));

// ---------------- Job queue ----------------
const jobs = new Map();
const queue = [];
let working = false;

function enqueue(job) { queue.push(job); processNext(); }

async function processNext() {
  if (working || queue.length === 0) return;
  working = true;
  const job = queue.shift();
  const state = jobs.get(job.id);
  try {
    await PIPELINES[job.tool](job, state);
    state.status = "done";
    state.progress = 100;
  } catch (err) {
    console.error(`Job ${job.id} (${job.tool}) failed:`, err.message);
    state.status = "failed";
    state.error = err.message;
  } finally {
    for (const f of job.tempFiles || []) fs.rm(f, { force: true }, () => {});
    working = false;
    processNext();
  }
}

// ---------------- Shared helpers ----------------
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", ...args], { maxBuffer: 64 * 1024 * 1024 }, (e, _o, se) =>
      e ? reject(new Error("ffmpeg: " + String(se).slice(-400))) : resolve()
    );
  });
}

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      (e, out) => (e ? reject(e) : resolve(parseFloat(out) || 0)));
  });
}

async function aai(pathname, options = {}) {
  const res = await fetch(AAI + pathname, {
    ...options,
    headers: { authorization: AAI_KEY, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`AssemblyAI ${res.status}: ${await res.text()}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transcribe a video's audio. extra = additional AssemblyAI features.
async function transcribe(job, state, extra = {}) {
  if (!AAI_KEY) throw new Error("Server missing ASSEMBLYAI_API_KEY");
  state.status = "extracting audio"; state.progress = 10;
  const audio = job.videoPath + ".mp3";
  job.tempFiles.push(audio);
  await ffmpeg(["-i", job.videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", audio]);

  state.status = "uploading to AI"; state.progress = 22;
  const up = await aai("/upload", { method: "POST", body: fs.readFileSync(audio) });

  state.status = "AI is listening"; state.progress = 35;
  const params = { audio_url: up.upload_url, ...extra };
  if (job.language && job.language !== "auto") params.language_code = job.language;
  else params.language_detection = true;
  const tr = await aai("/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  for (;;) {
    await sleep(3000);
    const r = await aai(`/transcript/${tr.id}`);
    if (r.status === "completed") return r;
    if (r.status === "error") throw new Error("Transcription failed: " + r.error);
    state.progress = Math.min(60, state.progress + 3);
  }
}

// Cut [start..end] seconds of the source into a result file.
async function cutClip(job, start, end, name) {
  const out = path.join(RESULTS, name);
  await ffmpeg(["-ss", String(start), "-to", String(end), "-i", job.videoPath,
    "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", out]);
  return name;
}

// Turn AI segments (ms) into clips of clipLen seconds, centered on each segment.
async function cutSegments(job, state, segments, clipLen, label) {
  const duration = await ffprobeDuration(job.videoPath);
  const files = [];
  let i = 0;
  for (const seg of segments) {
    i++;
    state.status = `cutting ${label} ${i} of ${segments.length}`;
    state.progress = 60 + Math.round((i / segments.length) * 35);
    const center = (seg.start + seg.end) / 2000;
    let start = Math.max(0, center - clipLen / 2);
    let end = Math.min(duration, start + clipLen);
    start = Math.max(0, end - clipLen);
    files.push(await cutClip(job, start.toFixed(2), end.toFixed(2), `${job.id}-${label}${i}.mp4`));
  }
  if (!files.length) throw new Error("The AI could not find suitable moments in this video.");
  state.resultFiles = files;
}

function buildSrt(words) {
  if (!words.length) return "";
  const lines = []; let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 7 || w.end - cur[0].start > 3500) { lines.push(cur); cur = []; }
  }
  if (cur.length) lines.push(cur);
  const ts = (ms) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
  };
  return lines.map((l, i) =>
    `${i + 1}\n${ts(l[0].start)} --> ${ts(l[l.length - 1].end)}\n${l.map((w) => w.text).join(" ")}\n`
  ).join("\n");
}

// ---------------- Tool pipelines ----------------
const PIPELINES = {

  async captions(job, state) {
    const r = await transcribe(job, state);
    state.status = "writing captions"; state.progress = 75;
    const srt = buildSrt(r.words || []);
    if (!srt) throw new Error("No speech was detected in this video.");
    const srtPath = job.videoPath + ".srt";
    job.tempFiles.push(srtPath);
    fs.writeFileSync(srtPath, srt);
    state.status = "burning captions onto video"; state.progress = 88;
    const out = job.id + ".mp4";
    const style = "FontSize=20,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=2,MarginV=30";
    await ffmpeg(["-i", job.videoPath, "-vf",
      `subtitles=${srtPath.replace(/\\/g, "/")}:force_style='${style}'`,
      "-c:a", "copy", path.join(RESULTS, out)]);
    state.resultFiles = [out];
  },

  async subtitles(job, state) { return PIPELINES.captions(job, state); },

  // AI finds the most important moments; we cut them into 60s reels.
  async reels(job, state) {
    const r = await transcribe(job, state, { auto_highlights: true });
    const hl = (r.auto_highlights_result?.results || [])
      .sort((a, b) => b.rank - a.rank).slice(0, 3)
      .map((h) => ({ start: h.timestamps[0].start, end: h.timestamps[0].end }));
    await cutSegments(job, state, hl, 60, "reel");
  },

  // Same engine, tighter 30s clips for shorts.
  async shorts(job, state) {
    const r = await transcribe(job, state, { auto_highlights: true });
    const hl = (r.auto_highlights_result?.results || [])
      .sort((a, b) => b.rank - a.rank).slice(0, 3)
      .map((h) => ({ start: h.timestamps[0].start, end: h.timestamps[0].end }));
    await cutSegments(job, state, hl, 30, "short");
  },

  // AI sentiment analysis finds the most positive/lively spoken moments.
  async memes(job, state) {
    const r = await transcribe(job, state, { sentiment_analysis: true });
    const pos = (r.sentiment_analysis_results || [])
      .filter((s) => s.sentiment === "POSITIVE")
      .sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    if (!pos.length) throw new Error("The AI found no clearly lively moments to clip.");
    await cutSegments(job, state, pos, 20, "meme");
  },

  // AI splits the video into chapters; we stitch a taste of each into a summary.
  async summary(job, state) {
    const r = await transcribe(job, state, { auto_chapters: true });
    const chapters = (r.chapters || []).slice(0, 6);
    if (!chapters.length) throw new Error("The AI could not detect chapters in this video.");
    const duration = await ffprobeDuration(job.videoPath);
    const parts = [];
    for (let i = 0; i < chapters.length; i++) {
      state.status = `clipping chapter ${i + 1} of ${chapters.length}`;
      state.progress = 60 + Math.round(((i + 1) / chapters.length) * 30);
      const start = Math.min(chapters[i].start / 1000, Math.max(0, duration - 1));
      const end = Math.min(start + 8, duration);
      const p = path.join(WORK, `${job.id}-part${i}.mp4`);
      job.tempFiles.push(p);
      await ffmpeg(["-ss", String(start), "-to", String(end), "-i", job.videoPath,
        "-c:v", "libx264", "-preset", "fast", "-c:a", "aac",
        "-vf", "scale=1280:-2", "-r", "30", p]);
      parts.push(p);
    }
    state.status = "stitching summary"; state.progress = 94;
    const list = path.join(WORK, `${job.id}-list.txt`);
    job.tempFiles.push(list);
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    const out = job.id + ".mp4";
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", path.join(RESULTS, out)]);
    state.resultFiles = [out];
  },

  // Precise cut between start and end seconds (from the app's editor UI).
  async editor(job, state) {
    state.status = "cutting"; state.progress = 40;
    const duration = await ffprobeDuration(job.videoPath);
    const start = Math.max(0, parseFloat(job.opts.start) || 0);
    const end = Math.min(duration, parseFloat(job.opts.end) || duration);
    if (end <= start) throw new Error("End time must be after start time.");
    state.resultFiles = [await cutClip(job, start, end, job.id + ".mp4")];
  },

  // Background noise removal (real signal processing, runs locally, free).
  async denoise(job, state) {
    state.status = "removing background noise"; state.progress = 40;
    const out = job.id + ".mp4";
    await ffmpeg(["-i", job.videoPath, "-c:v", "copy",
      "-af", "afftdn=nf=-25", path.join(RESULTS, out)]);
    state.resultFiles = [out];
  },

  // Quality boost: upscale 1.5x + sharpen + slight color/contrast lift.
  async enhance(job, state) {
    state.status = "enhancing video"; state.progress = 40;
    const out = job.id + ".mp4";
    await ffmpeg(["-i", job.videoPath,
      "-vf", "scale=iw*1.5:-2:flags=lanczos,unsharp=5:5:0.8:5:5:0.4,eq=contrast=1.05:saturation=1.1",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "copy",
      path.join(RESULTS, out)]);
    state.resultFiles = [out];
  },

  // Talking avatar via D-ID: photo + script -> speaking video.
  async avatar(job, state) {
    if (!DID_KEY) throw new Error("Avatar needs DID_API_KEY on the server (get one at d-id.com).");
    if (!job.imagePath) throw new Error("Avatar needs a photo (image upload).");
    if (!job.opts.script) throw new Error("Avatar needs a script to speak.");
    const auth = "Basic " + Buffer.from(DID_KEY + ":").toString("base64");

    state.status = "uploading photo"; state.progress = 20;
    const form = new FormData();
    form.append("image", new Blob([fs.readFileSync(job.imagePath)]), "photo.png");
    const img = await didFetch("/images", { method: "POST", body: form }, auth);

    state.status = "avatar is learning to speak"; state.progress = 40;
    const voices = {
      "en:male": "en-US-GuyNeural", "en:female": "en-US-JennyNeural",
      "hi:male": "hi-IN-MadhurNeural", "hi:female": "hi-IN-SwaraNeural",
      "es:male": "es-ES-AlvaroNeural", "es:female": "es-ES-ElviraNeural",
      "fr:male": "fr-FR-HenriNeural", "fr:female": "fr-FR-DeniseNeural",
    };
    const vkey = `${(job.language || "en").slice(0, 2)}:${job.opts.voice || "female"}`;
    const talk = await didFetch("/talks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_url: img.url,
        script: {
          type: "text", input: job.opts.script,
          provider: { type: "microsoft", voice_id: voices[vkey] || voices["en:female"] },
        },
      }),
    }, auth);

    for (;;) {
      await sleep(4000);
      const r = await didFetch(`/talks/${talk.id}`, {}, auth);
      if (r.status === "done") {
        state.status = "downloading avatar video"; state.progress = 92;
        const out = job.id + ".mp4";
        const vid = await fetch(r.result_url);
        fs.writeFileSync(path.join(RESULTS, out), Buffer.from(await vid.arrayBuffer()));
        state.resultFiles = [out];
        return;
      }
      if (r.status === "error" || r.status === "rejected") throw new Error("Avatar generation failed.");
      state.progress = Math.min(88, state.progress + 5);
    }
  },

  // AI video generation via Luma Dream Machine: text prompt -> video.
  async create(job, state) {
    if (!LUMA_KEY) throw new Error("AI video creator needs LUMA_API_KEY on the server (lumalabs.ai).");
    if (!job.opts.script) throw new Error("Describe the video you want created.");
    state.status = "AI is imagining your video"; state.progress = 20;
    const headers = { authorization: `Bearer ${LUMA_KEY}`, "content-type": "application/json" };
    const gen = await lumaFetch("/dream-machine/v1/generations", {
      method: "POST", headers,
      body: JSON.stringify({ prompt: "cartoon style: " + job.opts.script, model: "ray-2" }),
    });
    for (;;) {
      await sleep(5000);
      const r = await lumaFetch(`/dream-machine/v1/generations/${gen.id}`, { headers });
      if (r.state === "completed") {
        state.status = "downloading your creation"; state.progress = 92;
        const out = job.id + ".mp4";
        const vid = await fetch(r.assets.video);
        fs.writeFileSync(path.join(RESULTS, out), Buffer.from(await vid.arrayBuffer()));
        state.resultFiles = [out];
        return;
      }
      if (r.state === "failed") throw new Error("Video generation failed: " + (r.failure_reason || ""));
      state.progress = Math.min(88, state.progress + 4);
    }
  },
};

async function didFetch(pathname, options, auth) {
  const res = await fetch("https://api.d-id.com" + pathname, {
    ...options, headers: { authorization: auth, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`D-ID ${res.status}: ${await res.text()}`);
  return res.json();
}

async function lumaFetch(pathname, options) {
  const res = await fetch("https://api.lumalabs.ai" + pathname, options);
  if (!res.ok) throw new Error(`Luma ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------- API routes ----------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    tools: {
      transcriptionTools: Boolean(AAI_KEY),
      localTools: true,
      avatar: Boolean(DID_KEY),
      create: Boolean(LUMA_KEY),
    },
  });
});

app.post("/api/jobs",
  upload.fields([{ name: "video", maxCount: 1 }, { name: "image", maxCount: 1 }]),
  (req, res) => {
    const tool = req.body.tool;
    if (!PIPELINES[tool]) return res.status(400).json({ error: `Unknown tool: ${tool}` });
    const video = req.files?.video?.[0];
    const image = req.files?.image?.[0];
    if (!video && !image && tool !== "create")
      return res.status(400).json({ error: "No media uploaded" });
    const id = crypto.randomUUID();
    jobs.set(id, { status: "queued", progress: 0 });
    enqueue({
      id, tool,
      videoPath: video?.path, imagePath: image?.path,
      language: req.body.language || "auto",
      opts: { start: req.body.start, end: req.body.end, script: req.body.script, voice: req.body.voice },
      tempFiles: [video?.path, image?.path].filter(Boolean),
    });
    res.json({ jobId: id });
  });

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status, progress: job.progress, error: job.error || null,
    resultUrl: job.resultFiles ? `/results/${job.resultFiles[0]}` : null,
    resultUrls: (job.resultFiles || []).map((f) => `/results/${f}`),
  });
});

app.listen(PORT, () => {
  console.log(`Video AI backend v2 on port ${PORT}`);
  if (!AAI_KEY) console.log("Set ASSEMBLYAI_API_KEY for caption/reel/short/meme/summary tools");
  if (!DID_KEY) console.log("Set DID_API_KEY for the talking avatar tool");
  if (!LUMA_KEY) console.log("Set LUMA_API_KEY for the AI video creator tool");
});
