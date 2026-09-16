/**
 * The planner: turns a bare topic into a structured storyboard.
 *
 * Two paths exist, on purpose:
 *
 *  1. `loadStoryboard({ file })` - the authoring path. Cline (or an LLM, or a
 *     human) writes a storyboard JSON and VideoForge renders it verbatim. This
 *     gives the best scripts and is the recommended way to use VideoForge.
 *
 *  2. `planFromTopic(topic)` - the zero-setup path. A deterministic template
 *     planner shapes a topic into hook / body beats / call-to-action with a
 *     consistent visual look, so the app is useful without any LLM at all.
 */
import { DEFAULT_LOOK, DEFAULT_NEGATIVE, LIMITS, normalizeStoryboard } from './storyboard.js';
import { readJson } from '../util/fs.js';

/** Topics are matched against these to pick beats and a visual look. */
export const INTENTS = [
  {
    id: 'fitness',
    label: 'fitness',
    match: /workout|exercise|fitness|training|gym|muscle|strength|yoga|pilates|abs|cardio|stretch|diet|nutrition|lunge|squat|plank|push-?up|deadlift|hiit|body/i,
    subject: 'a fit, athletic fitness model in modern workout apparel',
    look: `${DEFAULT_LOOK}, bright airy gym or studio, athletic apparel, energetic and motivating`,
    beats: [
      {
        title: 'The mistake',
        narration: 'Most people get {topic} wrong, and it usually comes down to one simple thing.',
        image: '{subject} standing in a bright modern studio, arms relaxed, explaining directly to camera',
      },
      {
        title: 'Warm up',
        narration: 'Start with two minutes of easy movement. You are waking the joints up, not training them yet.',
        image: '{subject} mid warm-up stretch, side lunge, soft studio light behind',
      },
      {
        title: 'Form first',
        narration: 'Form beats intensity every single time. Slow, controlled reps build the strength that lasts.',
        image: '{subject} demonstrating a controlled squat with perfect posture, low camera angle',
      },
      {
        title: 'The main set',
        narration: 'Now add resistance. Three sets, eight to twelve reps, stopping two reps before failure.',
        image: '{subject} performing a dumbbell row, focused expression, gym equipment softly blurred',
      },
      {
        title: 'Recover',
        narration: 'Rest is where the work actually pays off. Give each muscle group a full day between sessions.',
        image: '{subject} cooling down with a water bottle, calm relaxed posture, warm afternoon light',
      },
    ],
    outro:
      'That is {topic}, simplified. Pick one thing from this video and repeat it this week, and you will feel the difference.',
  },
  {
    id: 'recipe',
    label: 'cooking',
    match: /recipe|cook|baking|bake|meal|dish|food|coffee|smoothie|kitchen/i,
    subject: 'a tidy modern kitchen counter with fresh ingredients',
    look: `${DEFAULT_LOOK}, overhead food styling, warm natural light, shallow focus on the dish`,
    beats: [
      {
        title: 'Why this works',
        narration: 'This is {topic}, and the whole thing takes less time than waiting for a delivery.',
        image: '{subject} fully laid out, ingredients arranged neatly and ready',
      },
      {
        title: 'Prep',
        narration: 'Get everything chopped and measured before the heat goes on. That is the whole trick.',
        image: 'close up of hands chopping fresh ingredients on a wooden board, sharp detail',
      },
      {
        title: 'Build the base',
        narration: 'Heat the pan, add the aromatics, and give them a full minute to open up.',
        image: 'aromatics sizzling in a pan, steam catching the light, rich colour',
      },
      {
        title: 'Finish',
        narration: 'Add the rest, taste it, and season one more time. Your palate is the final judge.',
        image: 'finished plated dish, garnished, glossy sauce, appetising presentation',
      },
    ],
    outro:
      'That is {topic} done. Save this one, and tell me how yours turned out.',
  },
  {
    id: 'explainer',
    label: 'explainer',
    match: /.*/,
    subject: 'a clean modern set with soft depth of field',
    look: `${DEFAULT_LOOK}, minimal modern set, soft directional light, muted palette`,
    beats: [
      {
        title: 'The hook',
        narration: 'Here is what almost everyone gets wrong about {topic}.',
        image: '{subject} with an abstract visual metaphor for {topic}',
      },
      {
        title: 'The basics',
        narration: 'Start with the fundamentals, because {topic} only makes sense once the basics are clear.',
        image: 'clear illustrative close up representing the fundamentals of {topic}',
      },
      {
        title: 'How it works',
        narration: 'Once you see how the pieces connect, {topic} stops being complicated.',
        image: 'detail shot showing the inner workings or process behind {topic}',
      },
      {
        title: 'In practice',
        narration: 'In practice, this is what it looks like when {topic} is done properly.',
        image: 'real world application of {topic} in a natural setting, candid framing',
      },
      {
        title: 'Takeaway',
        narration: 'So the one thing to remember about {topic} is this.',
        image: 'calm closing shot that summarises {topic}, generous negative space',
      },
    ],
    outro: 'That is {topic}, in plain language. Follow for more like this.',
  },
];

/** Pick the intent whose regex matches, falling back to the generic explainer. */
export function detectIntent(topic) {
  return INTENTS.find((intent) => intent.match.test(String(topic))) ?? INTENTS[INTENTS.length - 1];
}

/** Fill {topic} / {subject} placeholders in a beat template. */
/** Fill {topic} / {subject} placeholders in a beat template. */
export function fillTemplate(text, { topic, subject }) {
  return String(text)
    .replaceAll('{topic}', topic)
    .replaceAll('{subject}', subject)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic planner: topic in, storyboard out.
 *
 * @param {string} topic
 * @param {object} [opts] { scenes, seconds, voice, speed, lang, aspect }
 * @returns {object} a raw (pre-normalisation) storyboard
 */
export function planFromTopic(topic, opts = {}) {
  const cleanTopic = String(topic ?? '').trim();
  if (!cleanTopic) throw new Error('A topic is required to plan a video.');

  const intent = detectIntent(cleanTopic);
  const ctx = { topic: cleanTopic, subject: intent.subject };

  const requested = Number(opts.scenes);
  const wanted = Math.max(
    2,
    Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : intent.beats.length + 1,
      LIMITS.maxScenes,
    ),
  );

  const bodyBeats = intent.beats.slice(0, Math.max(1, wanted - 1));

  const scenes = bodyBeats.map((beat, index) => {
    const narration = fillTemplate(beat.narration, ctx);
    const image = fillTemplate(beat.image, ctx);
    return {
      id: index + 1,
      title: beat.title,
      narration,
      image_prompt: image,
      // Animate the keyframe with a gentle push when video models are absent.
      video_prompt: `${image}, subtle natural movement, cinematic`,
      seconds: opts.seconds ?? null,
      motion: 'auto',
    };
  });

  const outroImage = fillTemplate(
    'confident closing shot representing {topic}, generous negative space, warm light',
    ctx,
  );
  scenes.push({
    id: scenes.length + 1,
    title: 'Wrap up',
    narration: fillTemplate(intent.outro, ctx),
    image_prompt: outroImage,
    video_prompt: `${outroImage}, slow gentle camera push in`,
    seconds: opts.seconds ?? null,
    motion: 'kenburns',
  });

  return {
    topic: cleanTopic,
    title: titleFromTopic(cleanTopic),
    description: `A ${intent.label} video about ${cleanTopic}, generated by VideoForge.`,
    aspect: opts.aspect ?? '16:9',
    look: opts.look ?? intent.look,
    negative: opts.negative ?? DEFAULT_NEGATIVE,
    voice: opts.voice,
    speed: opts.speed,
    lang: opts.lang,
    scenes,
  };
}

/** "realistic 4k fitness model workout" -> "Realistic 4K Fitness Model Workout" */
export function titleFromTopic(topic) {
  return String(topic)
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (/^[0-9]+k$/i.test(word)) return word.toUpperCase();
      if (word.length <= 3 && word === word.toLowerCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Load a storyboard from a file, or plan one from a topic.
 *
 * @param {object} req { file, topic, config, defaults, scenes }
 * @returns {Promise<{storyboard: object, warnings: string[], source: string, mode: string}>}
 */
export async function loadStoryboard({ file, topic, config, defaults = {}, scenes } = {}) {
  if (file) {
    const raw = await readJson(file);
    const normalized = normalizeStoryboard(raw, { config, defaults });
    return { ...normalized, source: file, mode: 'file' };
  }

  if (!topic) {
    throw new Error('Provide either a storyboard file or a topic to plan from.');
  }

  const raw = planFromTopic(topic, { ...defaults, scenes });
  const normalized = normalizeStoryboard(raw, { config, defaults });
  return { ...normalized, source: 'template-planner', mode: 'template' };
}

export default { planFromTopic, loadStoryboard, detectIntent, titleFromTopic, INTENTS };
