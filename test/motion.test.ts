import assert from 'node:assert/strict';
import test from 'node:test';

import { gestureActions } from '../src/devices/wda-remote.js';
import { createA11yBridgeDriver, gestureParams } from '../src/drivers/a11y-bridge.js';
import {
    DEFAULT_MOTION_EVENT_COST_MS, createAdbDriver, createMotionEventBudget, motionEventCommand, samplePath,
} from '../src/drivers/adb.js';
import type { CommandResult, CommandRunner } from '../src/drivers/common.js';
import type { TimedPoint } from '../src/drivers/types.js';
import {
    PAUSE_SHAPES, SAMPLE_COUNT, SWIPE_DURATION_MS, THUMB_ZONE,
    humanTap, pathKey, pauseCeilingMs, pauseMs, thumbSwipe,
} from '../src/motion/gesture.js';
import { defaultMotionProfile, motionProfileFor, motionSettingsProblem, validateMotionSettings } from '../src/motion/profile.js';
import { createRng, seedForExecution } from '../src/motion/rng.js';
import { createMotionSource } from '../src/motion/source.js';
import { parseStartJitterMinutes, startJitterMs } from '../src/scheduler/executor.js';

const SCREEN = { width: 1080, height: 2400 };

/** How far each sample sits from the straight line between the ends, positive to the right of it. */
function deviations(path: TimedPoint[]): number[] {
    const first = path[0]!;
    const last = path[path.length - 1]!;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const length = Math.hypot(dx, dy);
    return path.map(({ x, y }) => ((x - first.x) * dy - (y - first.y) * dx) / length);
}

test('a thumb swipe starts in the thumb zone, on the hand it was drawn for', () => {
    for (let seed = 0; seed < 200; seed += 1) {
        for (const hand of ['right', 'left'] as const) {
            const [start] = thumbSwipe({ screen: SCREEN, direction: 'up', hand, seed });
            const band = hand === 'right' ? THUMB_ZONE.right : THUMB_ZONE.left;
            // Points are rounded to a tenth of a pixel, so the band edges are too.
            const edge = 0.1;
            assert.ok(
                start!.x >= SCREEN.width * band.left - edge && start!.x <= SCREEN.width * band.right + edge,
                `x ${start!.x} for ${hand}`,
            );
            assert.ok(
                start!.y >= SCREEN.height * THUMB_ZONE.top - edge && start!.y <= SCREEN.height * THUMB_ZONE.bottom + edge,
                `y ${start!.y}`,
            );
        }
    }
});

test('the arc bows left under a right thumb and right under a left one', () => {
    for (let seed = 0; seed < 100; seed += 1) {
        const right = deviations(thumbSwipe({ screen: SCREEN, direction: 'up', hand: 'right', seed }));
        const left = deviations(thumbSwipe({ screen: SCREEN, direction: 'up', hand: 'left', seed }));
        // An upward swipe travels in -y, so "left of the straight line" is a positive cross product.
        assert.ok(Math.max(...right) > 0.5, `right-handed swipe did not bow: ${Math.max(...right)}`);
        assert.ok(Math.min(...left) < -0.5, `left-handed swipe did not bow: ${Math.min(...left)}`);
        // The ends are on the line; only the middle leaves it.
        assert.ok(Math.abs(right[0]!) < 0.01 && Math.abs(right[right.length - 1]!) < 0.01);
    }
});

test('a swipe is sampled, monotonic in time, and lands inside the duration band', () => {
    for (let seed = 0; seed < 300; seed += 1) {
        const path = thumbSwipe({ screen: SCREEN, direction: 'up', seed });
        assert.ok(path.length >= SAMPLE_COUNT.min && path.length <= SAMPLE_COUNT.max, `${path.length} samples`);
        assert.equal(path[0]!.t, 0);
        for (let index = 1; index < path.length; index += 1) {
            assert.ok(path[index]!.t > path[index - 1]!.t, 'time ran backwards');
        }
        const duration = path[path.length - 1]!.t;
        // An early lift takes the finger off before the stroke finishes, so the floor is lower
        // than the band's; the ceiling is the band's.
        assert.ok(duration >= SWIPE_DURATION_MS.min * 0.8 && duration <= SWIPE_DURATION_MS.max, `${duration} ms`);
        for (const { x, y } of path) {
            assert.ok(x >= 0 && x <= SCREEN.width && y >= 0 && y <= SCREEN.height, `${x},${y} off screen`);
        }
    }
});

test('every direction stays on the glass and travels the way it was asked to', () => {
    const axis = { up: -1, down: 1, left: -1, right: 1 } as const;
    for (const direction of ['up', 'down', 'left', 'right'] as const) {
        for (let seed = 0; seed < 60; seed += 1) {
            const path = thumbSwipe({ screen: SCREEN, direction, seed });
            const first = path[0]!;
            const last = path[path.length - 1]!;
            const travelled = direction === 'up' || direction === 'down' ? last.y - first.y : last.x - first.x;
            assert.equal(Math.sign(travelled), axis[direction], `${direction} went the wrong way`);
            assert.ok(path.every(({ x, y }) => x >= 0 && x <= SCREEN.width && y >= 0 && y <= SCREEN.height));
        }
    }
});

test('a run replays from its seed and differs from every other run', () => {
    assert.equal(
        pathKey(thumbSwipe({ screen: SCREEN, direction: 'up', seed: 'execution-7' })),
        pathKey(thumbSwipe({ screen: SCREEN, direction: 'up', seed: 'execution-7' })),
    );
    assert.notEqual(
        pathKey(thumbSwipe({ screen: SCREEN, direction: 'up', seed: 'execution-7' })),
        pathKey(thumbSwipe({ screen: SCREEN, direction: 'up', seed: 'execution-8' })),
    );
    const replay = (seed: string) => {
        const motion = createMotionSource({ udid: 'R58N1', seed });
        return [motion.swipe(SCREEN), motion.swipe(SCREEN), motion.pause('betweenVideos')];
    };
    assert.deepEqual(replay('run-a'), replay('run-a'));
    assert.notDeepEqual(replay('run-a'), replay('run-b'));
    // The execution id is the only input; two executions never share a seed.
    assert.equal(seedForExecution('exec-1'), seedForExecution('exec-1'));
    assert.notEqual(seedForExecution('exec-1'), seedForExecution('exec-2'));
});

test('no two swipes in a row are the same path', () => {
    const motion = createMotionSource({ udid: 'R58N1', seed: 'repeat-check' });
    let previous = '';
    for (let index = 0; index < 500; index += 1) {
        const key = pathKey(motion.swipe(SCREEN));
        assert.notEqual(key, previous, `swipe ${index} repeated the one before it`);
        previous = key;
    }
});

test('a tap jitters around the point and holds for a human length of time', () => {
    const random = createRng('taps');
    for (let index = 0; index < 500; index += 1) {
        const { point, pressMs } = humanTap({ x: 500, y: 900 }, random);
        assert.ok(Math.abs(point.x - 500) <= 6 && Math.abs(point.y - 900) <= 6);
        assert.ok(pressMs >= 40 && pressMs <= 120, `${pressMs} ms`);
    }
    assert.notDeepEqual(humanTap({ x: 500, y: 900 }, 'a'), humanTap({ x: 500, y: 900 }, 'b'));
});

test('pauses stay inside their kind\'s bounds and cluster around its median', () => {
    for (const kind of Object.keys(PAUSE_SHAPES) as Array<keyof typeof PAUSE_SHAPES>) {
        const shape = PAUSE_SHAPES[kind];
        const random = createRng(`pauses:${kind}`);
        const draws = Array.from({ length: 4_000 }, () => pauseMs(kind, random));
        assert.ok(Math.min(...draws) >= shape.minMs, `${kind} went below its floor`);
        assert.ok(Math.max(...draws) <= pauseCeilingMs(kind), `${kind} went above its ceiling`);
        const sorted = [...draws].sort((left, right) => left - right);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        assert.ok(
            median > shape.medianMs * 0.85 && median < shape.medianMs * 1.15,
            `${kind} median ${median} is nowhere near ${shape.medianMs}`,
        );
        // The long tail is rare but real: some draws are several times the median.
        assert.ok(sorted[sorted.length - 1]! > shape.medianMs * 2, `${kind} never once ran long`);
    }
});

test('a device gets a consistent person without being configured, and settings win when set', () => {
    assert.deepEqual(defaultMotionProfile('R58N12ABCDE'), defaultMotionProfile('R58N12ABCDE'));
    const hands = new Set<string>();
    const speeds = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
        const profile = defaultMotionProfile(`serial-${index}`);
        hands.add(profile.hand);
        speeds.add(profile.speed);
    }
    assert.deepEqual([...hands].sort(), ['left', 'right']);
    assert.deepEqual([...speeds].sort(), ['fast', 'normal', 'slow']);
    assert.deepEqual(motionProfileFor('R58N1', { hand: 'left' }).hand, 'left');
    assert.equal(motionProfileFor('R58N1', { speed: 'fast' }).speed, 'fast');
});

test('the API only accepts a whitelisted motion block', () => {
    assert.equal(motionSettingsProblem({ hand: 'left', speed: 'fast' }), null);
    assert.match(String(motionSettingsProblem({ hand: 'either' })), /motion.hand/);
    assert.match(String(motionSettingsProblem({ speed: 'brisk' })), /motion.speed/);
    assert.match(String(motionSettingsProblem({ udid: 'x' })), /no udid setting/);
    assert.match(String(motionSettingsProblem('right')), /must be an object/);
    assert.deepEqual(validateMotionSettings({ hand: 'left' }), { hand: 'left' });
    assert.equal(validateMotionSettings({}), undefined);
    assert.equal(validateMotionSettings(undefined), undefined);
});

// ── drivers ────────────────────────────────────────────────────────────────

function recordingAdb(calls: string[][], stdout = ''): CommandRunner {
    return async (file, args): Promise<CommandResult> => {
        calls.push([file, ...args]);
        return { stdout, stderr: '' };
    };
}

test('adb plays a path as one chained motionevent invocation', async () => {
    const calls: string[][] = [];
    const driver = createAdbDriver({ serial: 'R58N1', run: recordingAdb(calls), motionSeed: 'fixed' });
    await driver.gesture([
        { x: 540, y: 1800, t: 0 }, { x: 535, y: 1400, t: 90 }, { x: 528, y: 900, t: 200 }, { x: 525, y: 700, t: 300 },
    ]);
    assert.equal(calls.length, 1);
    const [file, dash, serial, shell, command] = calls[0]!;
    assert.deepEqual([file, dash, serial, shell], ['adb', '-s', 'R58N1', 'shell']);
    assert.equal(
        command,
        'input motionevent DOWN 540 1800; sleep 0.050; input motionevent MOVE 535 1400; '
        + 'sleep 0.070; input motionevent MOVE 528 900; sleep 0.060; input motionevent UP 525 700',
    );
});

test('the motionevent chain sleeps only where the phone would otherwise be early', () => {
    const path: TimedPoint[] = [{ x: 0, y: 0, t: 0 }, { x: 10, y: 10, t: 200 }, { x: 20, y: 20, t: 220 }];
    const command = motionEventCommand(path, 40);
    assert.equal(
        command,
        'input motionevent DOWN 0 0; sleep 0.160; input motionevent MOVE 10 10; input motionevent UP 20 20',
    );
});

test('the point budget spends the gesture duration on what an event costs', () => {
    const budget = createMotionEventBudget(DEFAULT_MOTION_EVENT_COST_MS);
    // 300 ms at 40 ms an event: eight points, not the two dozen the generator drew.
    assert.equal(budget.points(300), 8);
    assert.equal(budget.points(0), 3, 'a gesture is never fewer than three points');
    assert.equal(budget.points(100_000), 24, 'nor more than two dozen');
    // A slow phone reports itself and gets fewer points next time.
    budget.record(10, 1_200);
    assert.ok(budget.costMs() > DEFAULT_MOTION_EVENT_COST_MS);
    assert.ok(budget.points(300) < 8);
    const path = Array.from({ length: 20 }, (_, index) => ({ x: index, y: index * 2, t: index * 15 }));
    const sampled = samplePath(path, 6);
    assert.equal(sampled.length, 6);
    assert.deepEqual(sampled[0], path[0]);
    assert.deepEqual(sampled[5], path[19]);
});

test('a phone without input motionevent falls back to a straight input swipe, once', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
        calls.push([file, ...args]);
        return { stdout: 'Usage: input [<source>] [-d DISPLAY_ID] <command> [<arg>...]', stderr: '' };
    };
    const driver = createAdbDriver({ serial: 'R58N1', run, motionSeed: 'fixed' });
    const path: TimedPoint[] = [{ x: 540, y: 1800, t: 0 }, { x: 530, y: 1200, t: 150 }, { x: 520, y: 700, t: 300 }];
    await driver.gesture(path);
    await driver.gesture(path);
    assert.equal(calls.length, 3, 'the second gesture should not try motionevent again');
    assert.deepEqual(calls[1]!.slice(3), ['shell', 'input', 'swipe', '540', '1800', '520', '700', '300']);
    assert.deepEqual(calls[2]!.slice(3), ['shell', 'input', 'swipe', '540', '1800', '520', '700', '300']);
});

test('a straight swipe stays straight, and an ordinary one becomes an arc', async () => {
    const straightCalls: string[][] = [];
    await createAdbDriver({ serial: 'R58N1', run: recordingAdb(straightCalls), motionSeed: 'fixed' })
        .swipe({ from: { x: 100, y: 200 }, to: { x: 100, y: 900 }, durationMs: 300, straight: true });
    assert.equal(
        straightCalls[0]!.at(-1),
        'input motionevent DOWN 100 200; sleep 0.260; input motionevent UP 100 900',
    );

    const arcCalls: string[][] = [];
    await createAdbDriver({ serial: 'R58N1', run: recordingAdb(arcCalls), motionSeed: 'fixed' })
        .swipe({ from: { x: 100, y: 200 }, to: { x: 100, y: 900 }, durationMs: 300 });
    const moves = arcCalls[0]!.at(-1)!.split('; ').filter((part) => part.includes('MOVE'));
    assert.ok(moves.length >= 5, 'an arc needs more than two points');
    assert.ok(new Set(moves.map((move) => move.split(' ')[3])).size > 1, 'every x was the same — that is a straight line');
});

test('the bridge gets a JSON list of timed points on /gesture, and /swipe is untouched', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), body: String(init.body) });
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    }) as unknown as typeof fetch;
    const driver = createA11yBridgeDriver({
        serial: 'R58N1', baseUrl: 'http://127.0.0.1:18300/', token: 'secret', fetchImpl, motionSeed: 'fixed',
    });
    await driver.gesture([{ x: 540, y: 1800, t: 0 }, { x: 520, y: 700, t: 300 }]);
    assert.equal(requests[0]!.url, 'http://127.0.0.1:18300/gesture');
    assert.equal(
        new URLSearchParams(requests[0]!.body).get('points'),
        '[{"x":540,"y":1800,"t":0},{"x":520,"y":700,"t":300}]',
    );
    assert.deepEqual(
        gestureParams([{ x: 1, y: 2, t: 0 }, { x: 3, y: 4, t: 40 }]),
        { points: '[{"x":1,"y":2,"t":0},{"x":3,"y":4,"t":40}]' },
    );
    assert.throws(() => gestureParams([{ x: 1, y: 2, t: 0 }]), /at least two points/);
});

test('WDA gets one pointerMove per sample, each carrying the gap before it', () => {
    const [source] = gestureActions([
        { x: 100, y: 600, t: 0 }, { x: 104, y: 500, t: 90 }, { x: 110, y: 380, t: 210 },
    ]);
    assert.equal(source!.type, 'pointer');
    assert.deepEqual(source!.parameters, { pointerType: 'touch' });
    assert.deepEqual(source!.actions, [
        { type: 'pointerMove', duration: 0, x: 100, y: 600, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: 90, x: 104, y: 500, origin: 'viewport' },
        { type: 'pointerMove', duration: 120, x: 110, y: 380, origin: 'viewport' },
        { type: 'pointerUp', button: 0 },
    ]);
    assert.throws(() => gestureActions([{ x: 1, y: 1, t: 0 }]), /at least two points/);
});

// ── run rhythm ─────────────────────────────────────────────────────────────

test('the start jitter is seeded, spread, and never reaches the run-window deadline', () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    const deadline = now + 30 * 60_000;
    const draws = Array.from({ length: 500 }, (_, index) => startJitterMs(`exec-${index}`, now, deadline, '0-4'));
    assert.ok(Math.min(...draws) >= 0);
    assert.ok(Math.max(...draws) <= 4 * 60_000);
    assert.ok(new Set(draws).size > 400, 'two phones on one schedule would start together');
    // The window is what caps it: a run claimed a minute before its deadline waits seconds, not minutes.
    assert.ok(startJitterMs('exec-1', now, now + 60_000, '0-4') <= 30_000);
    assert.equal(startJitterMs('exec-1', now, now, '0-4'), 0);
    assert.equal(startJitterMs('exec-1', now, deadline, '0'), 0);
    // Seeded by the execution id alone, so a misbehaving run replays with the same delay.
    assert.equal(startJitterMs('exec-9', now, deadline, '0-4'), startJitterMs('exec-9', now, deadline, '0-4'));
    assert.deepEqual(parseStartJitterMinutes(undefined), { min: 0, max: 4 });
    assert.deepEqual(parseStartJitterMinutes('6'), { min: 0, max: 6 });
    assert.deepEqual(parseStartJitterMinutes('2-5'), { min: 2, max: 5 });
    assert.throws(() => parseStartJitterMinutes('5-2'), /RUN_START_JITTER_MINUTES/);
    assert.throws(() => parseStartJitterMinutes('soon'), /RUN_START_JITTER_MINUTES/);
});
