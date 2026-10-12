#!/usr/bin/env node
/**
 * VideoForge web UI.
 *
 *   node src/server.js           (or: video-forge serve)
 *
 * A small express app that wraps the exact same `forge()` pipeline the CLI
 * uses, so anything rendered from the browser is indistinguishable from a
 * CLI run: ComfyUI MCP for visuals, Kokoro MCP for narration, ffmpeg for the
 * final cut.
 *
 * HTTP surface:
 *   GET  /                      the single-page UI (public/index.html)
 *   GET  /api/health            ComfyUI + Kokoro + ffmpeg status
 *   POST /api/generate          start a render { topic | storyboard, options }
 *   GET  /api/runs              list runs (live ones + finished manifests)
 *   GET  /api/runs/:id          one run's state
 *   DELETE /api/runs/:id        delete a finished run (removes its files)
 *   GET  /api/runs/:id/events   live progress (server-sent events)
 *   GET  /media/<path>          play finished videos / previews (output dir only)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { loadConfig, ROOT, VERSION } from './config.js';
import { createLogger } from './util/log.js';
import { forge } from './pipeline/forge.js';
import { TRANSITIONS } from './pipeline/storyboard.js';
import { ffmpegAvailable } from './util/ffmpeg.js';
import { ComfyClient } from './mcp/comfy.js';
import { LtxClient } from './mcp/ltx.js';
import { saveReferenceUpload, clearReferences, resolveReferences } from './pipeline/references.js';
import { isReferenceFile, referenceKind } from './pipeline/ltx.js';

/** Uploaded reference media is capped per file, so a browser cannot exhaust RAM. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const MAX_EVENTS_PER_RUN = 600;

/**
 * Every reference uploaded under a stamp, as LTX-Video conditioning descriptors.
 *
 * Filenames are ordered, because conditioning order is meaningful: the model
 * applies the items in list order, so a stable sort keeps a re-upload of the same
 * set in the same order. `strength`/`startFrame` stay at their defaults here -
 * the renderer and `normalizeReferences` resolve the final values.
 */
function listReferences(config, stamp) {
  const dir = path.join(config.referencesDir, String(stamp));
  if (!/^[\w.-]+$/.test(String(stamp)) || !fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => isReferenceFile(name))
    .sort()
    .map((name) => ({
      id: `${stamp}/${name}`,
      path: path.join(dir, name),
      filename: name,
      kind: referenceKind(name),
      strength: 1,
      startFrame: 0,
      bytes: fs.statSync(path.join(dir, name)).size,
    }));
}

function isLocalhostUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


/**
 * In-memory run registry. Live runs are tracked explicitly; finished runs are
 * discovered from manifest.json files in the output directory, so the gallery
 * survives server restarts.
 */
class RunRegistry {
  constructor() {
    this.runs = new Map(); // id -> run record
  }

  create(config) {
    const id = crypto.randomBytes(6).toString('hex');
    const run = {
      id,
      status: 'queued', // queued | running | done | error
      topic: null,
      title: null,
      events: [],
      subscribers: new Set(),
      manifest: null,
      output: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      config,
    };
    this.runs.set(id, run);
    return run;
  }

  publish(run, event) {
    const entry = { at: new Date().toISOString(), ...event };
    run.events.push(entry);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
    for (const res of run.subscribers) {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        run.subscribers.delete(res);
      }
    }
  }

  subscribe(run, res) {
    run.subscribers.add(res);
    res.write('retry: 3000\n\n');
    for (const entry of run.events) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    if (run.status === 'done' || run.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'end', status: run.status })}\n\n`);
      run.subscribers.delete(res);
    }
  }

  /** Finished runs from disk (newest first). */
  listFromDisk(config) {
    const out = [];
    if (!fs.existsSync(config.outputDir)) return out;
    for (const slug of fs.readdirSync(config.outputDir)) {
      const runDir = path.join(config.outputDir, slug);
      if (!fs.statSync(runDir).isDirectory()) continue;
      for (const stamp of fs.readdirSync(runDir)) {
        const manifestPath = path.join(runDir, stamp, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          out.push({
            id: `${slug}/${stamp}`,
            status: 'done',
            title: manifest.title ?? slug,
            manifestPath,
            manifest,
          });
        } catch {
          /* skip corrupt manifests */
        }
      }
    }
    return out.sort((a, b) =>
      String(b.manifest?.generatedAt ?? '').localeCompare(String(a.manifest?.generatedAt ?? '')),
    );
  }
}

export async function startServer({ port = 4321, config: configOverrides = {} } = {}) {
  const app = express();
  const registry = new RunRegistry();
  const staticDir = path.join(ROOT, 'public');
  const config = loadConfig(configOverrides);
  // Render reality: COMFYUI_URL is often unset (sync:false in render.yaml) or
  // points at localhost inside a container where nothing listens. Probe the
  // URL directly; if it refuses, fall through to the mock renderer instead of
  // dying — but remember why, so /api/health can tell the user how to fix it.
  if (config.backend === 'comfy' && isLocalhostUrl(config.comfyUrl)) {
    try {
      const probe = await fetchWithTimeout(`${config.comfyUrl.replace(/\/+$/, '')}/system_stats`, 8000);
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    } catch (error) {
      config.comfyUnreachable = `ComfyUI unreachable at ${config.comfyUrl} (${error.message}).`;
      config.backend = 'auto';
    }
  }
  const busy = { rendering: false };

  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(staticDir));

  // ---- health -------------------------------------------------------------
  app.get('/api/health', async (req, res) => {
    const health = {
      ok: true,
      version: VERSION,
      comfy: { ok: false, detail: null },
      kokoro: { ok: false, detail: null },
      ffmpeg: false,
      busy: busy.rendering,
      resolution: config.resolution,
      comfyUrl: config.comfyUrl,
    };

    if (config.comfyUnreachable) {
      health.hint =
        `${config.comfyUnreachable} Running with mock visuals - renders still work. ` +
        'For real diffusion on Render: set COMFYUI_URL to a tunnel or ' +
        'http://videoforge-comfyui:8188 (see docs/deploy-render.md).';
    }

    if (config.backend !== 'mock' && config.backend !== 'ltx') {
      const client = new ComfyClient(config);
      try {
        health.comfy = await client.health();
      } catch (error) {
        health.comfy = { ok: false, detail: { error: error.message.split('\n')[0] } };
      } finally {
        await client.close().catch(() => {});
      }
    } else {
      health.comfy = { ok: true, detail: { device: `skipped (${config.backend} backend)` } };
    }

    // LTX-Video is a *local* video diffusion backend - an alternative to
    // ComfyUI, not a requirement, so a missing install is reported rather than
    // fatal. `ready` tells the UI whether to offer it.
    const ltx = new LtxClient(config);
    try {
      health.ltx = await ltx.health();
    } catch (error) {
      health.ltx = { ok: false, detail: { error: error.message.split('\n')[0] } };
    } finally {
      await ltx.close().catch(() => {});
    }

    if (config.backend === 'ltx' && !health.ltx?.ok) {
      health.hint =
        `${health.ltx?.detail?.error ?? 'LTX-Video is not ready'}. ` +
        'Run `npm run setup:ltx`, or switch the backend to auto.';
    }
    health.backends = { comfy: health.comfy.ok, ltx: Boolean(health.ltx?.ok) };
    health.maxReferences = config.maxReferenceUploads;

    health.kokoro = {
      ok: fs.existsSync(config.kokoroMcp.command),
      detail: { command: config.kokoroMcp.command },
    };

    try {
      health.ffmpeg = await ffmpegAvailable(config.ffmpeg, config.ffprobe);
    } catch {
      health.ffmpeg = false;
    }

    health.ok = health.ffmpeg && (health.comfy.ok || config.backend !== 'comfy');
    res.json(health);
  });

  // ---- reference uploads (LTX-Video conditioning) ---------------------------
  //
  // A reference is an uploaded picture or video that the generation is
  // conditioned on - LTX-Video's "conditioning items". Uploads are written
  // straight to the local work directory: nothing is proxied anywhere, which is
  // what keeps a reference-conditioned render fully local.
  //
  // The body is the raw file bytes with the filename in a header, rather than
  // multipart/form-data, because Express 5 has no built-in multipart parser and
  // VideoForge deliberately ships without extra dependencies.
  app.post(
    '/api/references',
    express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const stamp = String(req.query.stamp ?? '').trim() || crypto.randomBytes(6).toString('hex');
      const rawName = String(
        req.headers['x-filename'] ?? req.query.filename ?? 'reference.bin',
      );
      const filename = decodeURIComponent(rawName);

      try {
        if (!isReferenceFile(filename)) {
          return res.status(400).json({
            ok: false,
            error:
              `"${path.basename(filename)}" is not a supported reference file. ` +
              'Upload an image (png, jpg, jpeg, webp, bmp, tiff) or a video ' +
              '(mp4, mov, avi, mkv, webm, m4v).',
          });
        }

        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ ok: false, error: 'The upload was empty.' });
        }

        const existing = listReferences(config, stamp).length;
        if (existing >= config.maxReferenceUploads) {
          return res.status(400).json({
            ok: false,
            error:
              `This run already has ${existing} reference(s); the limit is ` +
              `${config.maxReferenceUploads}.`,
          });
        }

        const saved = await saveReferenceUpload({
          config,
          stamp,
          index: existing + 1,
          filename,
          data: body,
        });

        res.json({
          ok: true,
          stamp,
          id: `${stamp}/${saved.filename}`,
          path: saved.path,
          filename: saved.filename,
          kind: saved.kind,
          bytes: saved.bytes,
          references: listReferences(config, stamp),
        });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    },
  );

  /** The references a stamp has uploaded so far, as conditioning descriptors. */
  app.get('/api/references', (req, res) => {
    const stamp = String(req.query.stamp ?? '').trim();
    if (!stamp) {
      return res.status(400).json({ ok: false, error: 'Provide a ?stamp= to list.' });
    }
    res.json({ ok: true, stamp, references: listReferences(config, stamp) });
  });

  /** Discard every reference uploaded under a stamp. */
  app.delete('/api/references', (req, res) => {
    const stamp = String(req.query.stamp ?? '').trim();
    if (!stamp || !/^[\w.-]+$/.test(stamp)) {
      return res.status(400).json({ ok: false, error: 'Provide a valid ?stamp=.' });
    }
    res.json({ ok: true, stamp, cleared: clearReferences(config, stamp) });
  });

  // ---- generate -----------------------------------------------------------
  app.post('/api/generate', async (req, res) => {
    if (busy.rendering) {
      return res.status(409).json({
        ok: false,
        error: 'A render is already in progress. Wait for it to finish or pick a run below.',
      });
    }

    const body = req.body ?? {};
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const storyboardFile =
      typeof body.storyboardFile === 'string' ? body.storyboardFile.trim() : '';
    if (!topic && !storyboardFile) {
      return res
        .status(400)
        .json({ ok: false, error: 'Provide a "topic" (or "storyboardFile").' });
    }

    const transition =
      typeof body.transition === 'string' ? body.transition.trim().toLowerCase() : '';
    if (transition && !TRANSITIONS.includes(transition)) {
      return res.status(400).json({
        ok: false,
        error: `Unknown transition "${body.transition}". Use ${TRANSITIONS.join(' | ')}.`,
      });
    }

    // Reference media. Two ways in: a `referenceStamp` naming files already
    // uploaded to /api/references, or explicit `references` (paths, for a
    // scripted client). Either way the list is validated here, so a bad upload
    // fails the request instead of the render.
    let references = [];
    try {
      const raw = body.referenceStamp
        ? listReferences(config, String(body.referenceStamp))
        : body.references ?? [];
      references = resolveReferences(raw, { config });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    const runConfig = loadConfig({
      ...configOverrides,
      resolution: body.resolution ?? undefined,
      voice: body.voice ?? undefined,
      speed: body.speed !== undefined ? Number(body.speed) : undefined,
      steps: body.steps !== undefined ? Number(body.steps) : undefined,
      backend: body.backend ?? undefined,
      fps: body.fps !== undefined ? Number(body.fps) : undefined,
      ltxModel: body.ltxModel ? String(body.ltxModel) : undefined,
    });

    const run = registry.create(runConfig);
    run.topic = topic || storyboardFile;
    run.references = references.references ?? [];

    const log = createLogger({
      silent: true,
      onEvent: (event) => {
        registry.publish(run, { type: 'log', level: event.level, message: event.message });
      },
    });

    busy.rendering = true;
    run.status = 'running';
    registry.publish(run, { type: 'start', topic: run.topic });

    // Render in the background; the request returns immediately with the id.
    forge({
      topic: topic || undefined,
      storyboardFile: storyboardFile || undefined,
      scenes: body.scenes !== undefined ? Number(body.scenes) : undefined,
      transition: transition || undefined,
      config: {
        resolution: runConfig.resolution,
        voice: runConfig.kokoro.voice,
        speed: runConfig.kokoro.speed,
        steps: runConfig.steps,
        backend: runConfig.backend,
        fps: runConfig.fps,
        transition: runConfig.transition,
        transitionSeconds: runConfig.transitionSeconds,
        cache: runConfig.cache,
        outputDir: runConfig.outputDir,
        workDir: runConfig.workDir,
        ltxModel: body.ltxModel ?? undefined,
      },
      logger: log,
      onEvent: (event) => {
        if (event?.type) registry.publish(run, event);
      },
      references: references.references ?? [],
    })
      .then((result) => {
        run.status = 'done';
        run.title = result.title;
        run.manifest = result.manifest;
        run.output = {
          video: result.video,
          master: result.master,
          thumbnail: result.thumbnail,
          manifestPath: result.manifestPath,
        };
        registry.publish(run, {
          type: 'complete',
          video: result.video,
          title: result.title,
          backend: result.backend,
          durationSeconds: result.manifest?.output?.durationSeconds ?? null,
        });
      })
      .catch((error) => {
        run.status = 'error';
        run.error = error.message;
        registry.publish(run, { type: 'error', message: error.message });
      })
      .finally(() => {
        run.finishedAt = new Date().toISOString();
        busy.rendering = false;
        for (const subscriber of run.subscribers) {
          try {
            subscriber.write(`data: ${JSON.stringify({ type: 'end', status: run.status })}\n\n`);
          } catch {
            /* subscriber gone */
          }
        }
        run.subscribers.clear();
      });

    res.json({ ok: true, id: run.id, status: run.status });
  });

  // ---- runs ---------------------------------------------------------------
  app.get('/api/runs', (req, res) => {
    const live = [...registry.runs.values()].map((run) => ({
      id: run.id,
      status: run.status,
      topic: run.topic,
      title: run.title,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      output: run.output,
      error: run.error,
      live: true,
    }));
    res.json({ ok: true, runs: [...live, ...registry.listFromDisk(config)] });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = registry.runs.get(req.params.id);
    if (run) {
      return res.json({
        ok: true,
        id: run.id,
        status: run.status,
        topic: run.topic,
        title: run.title,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        output: run.output,
        error: run.error,
        manifest: run.manifest,
        events: run.events,
      });
    }
    const [slug, stamp] = String(req.params.id).split('/');
    if (slug && stamp) {
      const manifestPath = path.join(config.outputDir, slug, stamp, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        return res.json({
          ok: true,
          id: req.params.id,
          status: 'done',
          manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        });
      }
    }
    res.status(404).json({ ok: false, error: 'Unknown run id.' });
  });

  /**
   * Delete a finished run. Removes the run's whole output directory (video,
   * master, thumbnail, segments, manifest) from disk. Live runs are refused
   * until they finish; ids that would escape the output directory are rejected.
   */
  app.delete('/api/runs/:id', (req, res) => {
    const id = String(req.params.id);
    const outputRoot = path.resolve(config.outputDir);
    const run = registry.runs.get(id);

    if (run && (run.status === 'queued' || run.status === 'running')) {
      return res.status(409).json({
        ok: false,
        error: 'That render is still in progress — wait for it to finish first.',
      });
    }

    let runDir;
    if (run?.output?.manifestPath) {
      // A live run that already finished: trust the output path it recorded.
      runDir = path.dirname(path.resolve(run.output.manifestPath));
    } else {
      // Finished runs are addressed as "<slug>/<stamp>".
      const parts = id.split('/');
      if (parts.length !== 2 || parts.some((p) => !p || p === '.' || p === '..')) {
        return res.status(404).json({ ok: false, error: 'Unknown run id.' });
      }
      runDir = path.join(outputRoot, ...parts);
    }

    if (!runDir.startsWith(outputRoot + path.sep)) {
      return res.status(400).json({ ok: false, error: 'Invalid run id.' });
    }

    registry.runs.delete(id);

    if (fs.existsSync(runDir)) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch (error) {
        return res
          .status(500)
          .json({ ok: false, error: `Could not delete run files: ${error.message}` });
      }
    }

    res.json({ ok: true, id, status: 'deleted' });
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const run = registry.runs.get(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Unknown run id.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    registry.subscribe(run, res);
    req.on('close', () => run.subscribers.delete(res));
  });

  // ---- media (finished renders) -------------------------------------------
  app.use('/media', (req, res) => {
    const relative = String(req.path).replace(/\\/g, '/').split('/').filter(Boolean);
    const target = path.resolve(config.outputDir, ...relative);
    const resolvedOutput = path.resolve(config.outputDir);
    if (!target.startsWith(resolvedOutput + path.sep)) {
      return res.status(403).json({ ok: false, error: 'Outside the output directory.' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }
    res.sendFile(target);
  });

  app.use((error, req, res, next) => {
    console.error(`[web] ${error.message}`);
    if (res.headersSent) return next(error);
    res.status(500).json({ ok: false, error: error.message });
  });

  await new Promise((resolve) => app.listen(port, resolve));
  console.log(`VideoForge web UI  ->  http://localhost:${port}`);
  console.log(`Output directory  ->  ${config.outputDir}`);
  return app;
}

// Run directly: `node src/server.js` or `npm start`.
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'src', 'server.js')) {
  const port = Number(process.env.PORT ?? 4321);
  startServer({ port }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export default startServer;

