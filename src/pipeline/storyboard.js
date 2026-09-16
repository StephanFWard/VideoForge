/**
 * The storyboard: the contract between "whoever writes the script" and "whatever
 * renders it".
 *
 * A storyboard is plain JSON, which is what lets Cline (or an LLM, or a human)
 * author a video by writing one file, then hand it to VideoForge to render.
 * `normalizeStoryboard` is the gate: it validates, fills defaults and reports
 * warnings rather than failing on anything recoverable.
 */

export const STORYBOARD_VERSION = 1;

/** Guard rails: videos are meant to be short-form. */
export const LIMITS = {
  maxScenes: 24,
  minSceneSeconds: 1,
  maxSceneSeconds: 20,
  defaultSceneSeconds: 5,
  maxNarrationChars: 1200,
};

/**
 * A tasteful, consistent look is applied to every image prompt unless the
 * storyboard overrides it. Keeping one look is what stops a multi-scene video
 * from looking like a patchwork of unrelated images.
 */
export const DEFAULT_LOOK =
  'professional editorial photography, natural soft window light, shallow depth of field, ' +
  'clean modern interior, realistic skin texture, high detail, 35mm lens, color graded';

export const DEFAULT_NEGATIVE =
  'cartoon, anime, illustration, 3d render, cgi, blurry, lowres, jpeg artifacts, ' +
  'deformed hands, extra limbs, watermark, text, logo, oversaturated, plastic skin';

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * Validate and canonicalise a storyboard.
 *
 * @param {object} raw        Parsed storyboard JSON.
 * @param {object} [opts]     { config, defaults }
 * @returns {{storyboard: object, warnings: string[]}}
 */
export function normalizeStoryboard(raw, { config, defaults = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A storyboard must be a JSON object with a "scenes" array.');
  }

  const warnings = [];
  const scenesIn = Array.isArray(raw.scenes) ? raw.scenes : [];
  if (scenesIn.length === 0) {
    throw new Error('The storyboard has no scenes. Add at least one scene with narration.');
  }
  if (scenesIn.length > LIMITS.maxScenes) {
    throw new Error(
      `The storyboard has ${scenesIn.length} scenes; the maximum is ${LIMITS.maxScenes}.`,
    );
  }

  const styleIn = raw.style && typeof raw.style === 'object' ? raw.style : {};
  const look = str(styleIn.look ?? raw.look, DEFAULT_LOOK);
  const negative = str(styleIn.negative ?? raw.negative_prompt, DEFAULT_NEGATIVE);

  const scenes = scenesIn.map((scene, index) => {
    if (!scene || typeof scene !== 'object') {
      throw new Error(`Scene ${index + 1} is not an object.`);
    }

    const narration = str(scene.narration ?? scene.voiceover ?? scene.say ?? scene.text);
    if (!narration) {
      throw new Error(`Scene ${index + 1} has no narration. Every scene needs a line to speak.`);
    }
    if (narration.length > LIMITS.maxNarrationChars) {
      warnings.push(
        `Scene ${index + 1}: narration is ${narration.length} characters; this will be a very long scene.`,
      );
    }

    const imagePrompt = str(scene.image_prompt ?? scene.imagePrompt ?? scene.prompt);
    const videoPrompt = str(scene.video_prompt ?? scene.videoPrompt) || imagePrompt;
    if (!imagePrompt && !videoPrompt) {
      warnings.push(
        `Scene ${index + 1}: no image or video prompt; the narration will be used as the prompt.`,
      );
    }

    const motion = str(scene.motion, 'auto').toLowerCase();
    if (!['auto', 'video', 'kenburns'].includes(motion)) {
      warnings.push(`Scene ${index + 1}: unknown motion "${motion}"; using "auto".`);
    }

    const rawSeconds = scene.seconds ?? scene.duration;
    const seconds = clamp(rawSeconds, LIMITS.minSceneSeconds, LIMITS.maxSceneSeconds, null);

    return {
      id: scene.id ?? index + 1,
      title: str(scene.title, `Scene ${index + 1}`),
      narration,
      imagePrompt: imagePrompt || narration,
      videoPrompt: videoPrompt || imagePrompt || narration,
      seconds,
      motion: ['auto', 'video', 'kenburns'].includes(motion) ? motion : 'auto',
      seed: Number.isFinite(Number(scene.seed)) ? Number(scene.seed) : null,
      transition: str(scene.transition, 'none'),
    };
  });

  const storyboard = {
    version: STORYBOARD_VERSION,
    topic: str(raw.topic ?? defaults.topic, 'Untitled'),
    title: str(raw.title ?? raw.topic ?? defaults.topic, 'Untitled'),
    description: str(raw.description),
    aspect: str(raw.aspect, '16:9'),
    look,
    negative,
    voice: str(raw.voice ?? defaults.voice ?? config?.kokoro?.voice, 'af_heart'),
    speed: clamp(raw.speed ?? defaults.speed ?? config?.kokoro?.speed, 0.5, 2, 1),
    lang: str(raw.lang ?? defaults.lang ?? config?.kokoro?.lang, 'en-us'),
    scenes,
  };

  // Duration maths use per-scene defaults, so report the estimate honestly.
  const estimated = scenes.reduce(
    (total, scene) => total + (scene.seconds ?? LIMITS.defaultSceneSeconds),
    0,
  );
  storyboard.estimatedSeconds = Math.round(estimated);

  if (scenes.length === 1) {
    warnings.push('Only one scene: the result is a single shot rather than a sequence.');
  }

  return { storyboard, warnings };
}

/** Total narration characters, useful for cost/time sanity checks. */
export function storyboardStats(storyboard) {
  const chars = storyboard.scenes.reduce((n, s) => n + s.narration.length, 0);
  const words = storyboard.scenes.reduce(
    (n, s) => n + s.narration.split(/\s+/).filter(Boolean).length,
    0,
  );
  return { scenes: storyboard.scenes.length, characters: chars, words };
}
