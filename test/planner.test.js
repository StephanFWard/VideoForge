/**
 * Planner and storyboard tests.
 *
 * These are the contract tests for "what a storyboard is": if they pass, a
 * hand-authored JSON file and a topic plan are interchangeable inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, fillTemplate, planFromTopic, titleFromTopic } from '../src/pipeline/planner.js';
import { normalizeStoryboard, storyboardStats, LIMITS } from '../src/pipeline/storyboard.js';

test('detectIntent picks the fitness template for workout topics', () => {
  assert.equal(detectIntent('Realistic 4K fitness model explaining a workout').id, 'fitness');
  assert.equal(detectIntent('how to do a proper squat').id, 'fitness');
  assert.equal(detectIntent('a beginner yoga flow').id, 'fitness');
});

test('detectIntent picks cooking and falls back to explainer', () => {
  assert.equal(detectIntent('how to bake sourdough bread').id, 'recipe');
  assert.equal(detectIntent('why the sky is blue').id, 'explainer');
});

test('titleFromTopic produces a readable title', () => {
  assert.equal(
    titleFromTopic('Realistic 4K fitness model explaining a workout'),
    'Realistic 4K Fitness Model Explaining a Workout',
  );
});

test('fillTemplate substitutes both placeholders', () => {
  assert.equal(
    fillTemplate('{subject} demonstrating {topic}', { topic: 'squats', subject: 'a coach' }),
    'a coach demonstrating squats',
  );
});

test('planFromTopic yields a normalisable storyboard with a call to action', () => {
  const raw = planFromTopic('Realistic 4K fitness model explaining a workout', {});
  const { storyboard, warnings } = normalizeStoryboard(raw, {});

  assert.ok(storyboard.scenes.length >= 2, 'should have at least a hook and an outro');
  assert.equal(storyboard.scenes.at(-1).title, 'Wrap up');
  assert.ok(storyboard.look.length > 20, 'should apply a consistent visual look');
  assert.ok(storyboard.negative.length > 10, 'should apply a negative prompt');
  assert.deepEqual(warnings, []);
});

test('planFromTopic honours an explicit scene count', () => {
  const { storyboard } = normalizeStoryboard(planFromTopic('a workout routine', { scenes: 3 }), {});
  assert.equal(storyboard.scenes.length, 3);
});

test('planFromTopic refuses an empty topic', () => {
  assert.throws(() => planFromTopic('   ', {}), /topic is required/i);
});

test('normalizeStoryboard fills defaults and clamps scene length', () => {
  const { storyboard } = normalizeStoryboard(
    {
      topic: 'x',
      scenes: [
        { narration: 'One.', seconds: 999 },
        { narration: 'Two.', seconds: -5 },
        { narration: 'Three.' },
      ],
    },
    {},
  );
  assert.equal(storyboard.scenes[0].seconds, LIMITS.maxSceneSeconds);
  assert.equal(storyboard.scenes[1].seconds, LIMITS.minSceneSeconds);
  assert.equal(storyboard.scenes[2].seconds, null, 'unset means "follow the narration"');
  assert.equal(storyboard.voice, 'af_heart');
  assert.equal(storyboard.scenes[0].id, 1);
});

test('normalizeStoryboard prefers explicit image prompts but never loses the narration', () => {
  const { storyboard } = normalizeStoryboard(
    { scenes: [{ narration: 'Say this', image_prompt: 'draw this' }] },
    {},
  );
  assert.equal(storyboard.scenes[0].imagePrompt, 'draw this');
  assert.equal(storyboard.scenes[0].narration, 'Say this');
});

test('normalizeStoryboard falls back to narration when no prompt is given', () => {
  const { storyboard, warnings } = normalizeStoryboard({ scenes: [{ narration: 'Only a line' }] }, {});
  assert.equal(storyboard.scenes[0].imagePrompt, 'Only a line');
  assert.ok(
    warnings.some((w) => /no image or video prompt/i.test(w)),
    `expected a missing-prompt warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('normalizeStoryboard rejects unusable input', () => {
  assert.throws(() => normalizeStoryboard(null, {}), /must be a JSON object/i);
  assert.throws(() => normalizeStoryboard({ scenes: [] }, {}), /no scenes/i);
  assert.throws(() => normalizeStoryboard({ scenes: [{ image_prompt: 'no narration' }] }, {}), /no narration/i);
  assert.throws(
    () => normalizeStoryboard({ scenes: Array.from({ length: LIMITS.maxScenes + 1 }, () => ({ narration: 'x' })) }, {}),
    /maximum is/i,
  );
});

test('normalizeStoryboard coerces an unknown motion into auto', () => {
  const { storyboard, warnings } = normalizeStoryboard(
    { scenes: [{ narration: 'x', motion: 'teleport' }] },
    {},
  );
  assert.equal(storyboard.scenes[0].motion, 'auto');
  assert.match(warnings.join(' '), /unknown motion/i);
});

test('storyboardStats summarises the script', () => {
  const { storyboard } = normalizeStoryboard(
    { scenes: [{ narration: 'one two three' }, { narration: 'four' }] },
    {},
  );
  assert.deepEqual(storyboardStats(storyboard), { scenes: 2, characters: 17, words: 4 });
});