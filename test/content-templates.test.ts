import assert from 'node:assert/strict';
import test from 'node:test';

import { clampCaption, renderCaptionTemplate, spintaxBranches } from '../src/content/templates.js';

test('renders the supported variables and normalises whitespace', () => {
    const caption = renderCaptionTemplate('{title}\n\n{hashtags}\n{account}', {
        title: 'Morning routine',
        hashtags: ['#fitness', 'gym '],
        account: '@handle',
    });
    assert.equal(caption, 'Morning routine\n\n#fitness #gym\n@handle');
});

test('spintax picks a branch from the injected RNG and is otherwise deterministic', () => {
    const template = 'Day {random:one|two|three} of the challenge';
    assert.equal(renderCaptionTemplate(template, {}, () => 0), 'Day one of the challenge');
    assert.equal(renderCaptionTemplate(template, {}, () => 0.5), 'Day two of the challenge');
    // A generator that returns exactly 1 must not index past the last branch.
    assert.equal(renderCaptionTemplate(template, {}, () => 1), 'Day three of the challenge');
    assert.deepEqual(spintaxBranches('a | b|c '), ['a', 'b', 'c']);
});

test('an unknown placeholder survives rendering so the typo is visible', () => {
    assert.equal(renderCaptionTemplate('{title} {nope}', { title: 'Hi' }), 'Hi {nope}');
});

test('an empty variable leaves no double spacing, and captions are clamped', () => {
    assert.equal(renderCaptionTemplate('{title} {hashtags} end', {}), 'end');
    assert.equal(clampCaption('x'.repeat(2500)).length, 2200);
    assert.equal(clampCaption('short'), 'short');
});
