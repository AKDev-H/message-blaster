// Builds the Lottie animations used by the 404, 500 and maintenance pages.
// Run with `node scripts/build-animations.mjs`; it writes web/animations/*.json.
import { mkdir, writeFile } from 'node:fs/promises';

const W = 480;
const H = 320;
const FPS = 60;

const hex = value => [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16) / 255).concat(1);
const C = {
    ink: hex('#1e2a2b'), harbor: hex('#2f6f73'), harborWash: hex('#e3efee'), sage: hex('#3c7a4e'), sageWash: hex('#e6f1e8'),
    rust: hex('#a14a3b'), rustWash: hex('#f7e9e5'), ochre: hex('#8a6417'), line: hex('#c9d3d0'), white: hex('#ffffff'),
};

const still = k => ({ a: 0, k });
const ease = { i: { x: 0.35, y: 1 }, o: { x: 0.55, y: 0 } };
const linear = { i: { x: 1, y: 1 }, o: { x: 0, y: 0 } };
/** Keyframes from [frame, value, easing?] triples; the last one holds. */
const anim = (...frames) => ({
    a: 1,
    k: frames.map(([t, s, curve = ease], index) => (index === frames.length - 1
        ? { t, s: [].concat(s) }
        : { t, s: [].concat(s), ...curve })),
});

const transform = (extra = {}) => ({
    ty: 'tr', p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100), sk: still(0), sa: still(0), ...extra,
});
const group = (items, extra) => ({ ty: 'gr', it: [...items, transform(extra)] });
const fill = (color, opacity = still(100)) => ({ ty: 'fl', c: still(color), o: opacity, r: 1 });
const stroke = (color, width, extra = {}) => ({ ty: 'st', c: still(color), o: still(100), w: still(width), lc: 2, lj: 2, ml: 4, ...extra });
const ellipse = (x, y, w, h = w) => ({ ty: 'el', p: still([x, y]), s: still([w, h]) });
const rect = (x, y, w, h, r) => ({ ty: 'rc', p: still([x, y]), s: still([w, h]), r: still(r) });
const path = (vertices, closed = false, inTangents, outTangents) => ({
    ty: 'sh',
    ks: still({ v: vertices, i: inTangents ?? vertices.map(() => [0, 0]), o: outTangents ?? vertices.map(() => [0, 0]), c: closed }),
});
const trim = (end, start = still(0)) => ({ ty: 'tm', s: start, e: end, o: still(0), m: 1 });

let nextIndex = 1;
function layer(name, shapes, { op, position = [0, 0], anchor = [0, 0], rotation = still(0), opacity = still(100), scale = still([100, 100, 100]), autoOrient = 0 }) {
    return {
        ddd: 0, ind: nextIndex++, ty: 4, nm: name, sr: 1, ao: autoOrient, ip: 0, op, st: 0, bm: 0,
        ks: {
            o: opacity, r: rotation, a: still([...anchor, 0]), s: scale,
            p: Array.isArray(position) ? still([...position, 0]) : position,
        },
        shapes,
    };
}

function composition(name, op, layers) {
    nextIndex = 1;
    return { v: '5.7.4', fr: FPS, ip: 0, op, w: W, h: H, nm: name, ddd: 0, assets: [], layers: layers.reverse() };
}

/** Cubic bezier helpers so the paper plane can ride exactly on the drawn route. */
function segmentLength(a, b) {
    let length = 0;
    let previous = a.v;
    for (let step = 1; step <= 24; step += 1) {
        const t = step / 24;
        const point = [0, 1].map(axis => {
            const p0 = a.v[axis], p1 = a.v[axis] + a.o[axis], p2 = b.v[axis] + b.i[axis], p3 = b.v[axis];
            return ((1 - t) ** 3 * p0) + (3 * (1 - t) ** 2 * t * p1) + (3 * (1 - t) * t ** 2 * p2) + (t ** 3 * p3);
        });
        length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
        previous = point;
    }
    return length;
}

// 404: a paper plane flies a dashed delivery route that loops back on itself and ends at an empty pin.
function lostMessage() {
    const op = 300;
    const route = [
        { v: [52, 250], i: [0, 0], o: [60, -10] },
        { v: [170, 200], i: [-50, 20], o: [50, -20] },
        { v: [236, 120], i: [-10, 40], o: [10, -40] },
        { v: [190, 82], i: [36, 0], o: [-36, 0] },
        { v: [166, 140], i: [-14, -34], o: [14, 34] },
        { v: [262, 176], i: [-50, 0], o: [50, 0] },
        { v: [372, 118], i: [-40, 30], o: [0, 0] },
    ];
    const start = 20;
    const end = 200;
    const lengths = route.slice(1).map((point, index) => segmentLength(route[index], point));
    const total = lengths.reduce((sum, value) => sum + value, 0);
    let travelled = 0;
    const positions = route.map((point, index) => {
        const t = start + ((end - start) * travelled) / total;
        const progress = (100 * travelled) / total;
        travelled += lengths[index] ?? 0;
        const next = route[index + 1];
        return { t, progress, s: [...point.v, 0], ...(next ? { to: [...point.o, 0], ti: [...next.i, 0], ...linear } : {}) };
    });

    const routePath = path(route.map(point => point.v), false, route.map(point => point.i), route.map(point => point.o));
    const dashes = [{ n: 'd', nm: 'dash', v: still(2) }, { n: 'g', nm: 'gap', v: still(9) }, { n: 'o', nm: 'offset', v: still(0) }];
    const trail = layer('route', [group([
        routePath,
        trim({ a: 1, k: positions.map(({ t, progress }, index) => (index === positions.length - 1 ? { t, s: [progress] } : { t, s: [progress], ...linear })) }),
        stroke(C.harbor, 3, { d: dashes }),
    ])], { op, opacity: anim([0, 0], [10, 100], [250, 100], [285, 0]) });

    const ghostRoute = layer('ghost route', [group([routePath, stroke(C.line, 1.5, { d: [{ n: 'd', nm: 'dash', v: still(2) }, { n: 'g', nm: 'gap', v: still(9) }] })])],
        { op, opacity: still(55) });

    const plane = layer('plane', [
        group([path([[16, 0], [-12, -11], [-6, 0], [-12, 11]], true), fill(C.white), stroke(C.ink, 2.2)]),
        group([path([[-6, 0], [16, 0]]), stroke(C.ink, 1.8)]),
    ], {
        op, autoOrient: 1,
        position: { a: 1, k: [...positions, { t: 230, s: [400, 96, 0], ...linear }, { t: 260, s: [410, 92, 0] }] },
        opacity: anim([0, 0], [start, 100], [228, 100], [258, 0]),
    });

    const pin = layer('empty pin', [
        group([
            path([[0, 20], [-14, -6], [0, -21], [14, -6]], true,
                [[4, -7], [0, 9], [-8, 0], [0, -8]],
                [[-4, -7], [0, -8], [8, 0], [0, 9]]),
            fill(C.white), stroke(C.rust, 2.4),
        ]),
        group([
            path([[-4.5, -10], [0, -14], [4.5, -10], [0, -5], [0, -3]], false,
                [[0, 0], [-2.5, 0], [0, -2.5], [2, -1.5], [0, 0]],
                [[0, -2.5], [2.5, 0], [0, 2.5], [0, 0], [0, 0]]),
            stroke(C.rust, 2.2),
        ]),
        group([ellipse(0, 1, 3), fill(C.rust)]),
    ], {
        op, position: [418, 116], anchor: [0, 20],
        scale: anim([0, [0, 0, 100]], [175, [0, 0, 100]], [195, [112, 112, 100]], [205, [100, 100, 100]], [272, [100, 100, 100]], [292, [0, 0, 100]]),
        rotation: anim([200, 0], [214, -9], [228, 7], [240, -3], [250, 0]),
    });

    const origin = layer('outbox', [group([ellipse(0, 0, 18), fill(C.harborWash), stroke(C.harbor, 2)]), group([ellipse(0, 0, 6), fill(C.harbor)])],
        { op, position: [52, 250], scale: anim([0, [0, 0, 100]], [14, [100, 100, 100]], [270, [100, 100, 100]], [292, [0, 0, 100]]) });

    return composition('Message lost on the way', op, [ghostRoute, trail, origin, pin, plane]);
}

// 500: a chat bubble is typing, the signal sparks, the bubble cracks and the dots drop away.
function brokenSignal() {
    const op = 240;
    const bubble = layer('bubble', [
        group([rect(0, 0, 170, 108, 26), fill(C.white), stroke(C.ink, 2.6)]),
        group([path([[-46, 52], [-62, 78], [-20, 54]], true), fill(C.white), stroke(C.ink, 2.6)]),
        group([path([[-46, 51], [-22, 51]]), stroke(C.white, 4)]),
    ], {
        op, position: [228, 152],
        rotation: anim([0, 0], [96, 0], [100, -4], [104, 4], [108, -3], [112, 2], [116, 0]),
    });

    const crack = layer('crack', [group([
        path([[-18, -54], [-4, -26], [-16, -12], [4, 10], [-8, 26], [6, 54]]),
        trim(anim([0, 0], [98, 0], [108, 100, linear], [200, 100], [212, 0])),
        stroke(C.rust, 3),
    ])], { op, position: [240, 152] });

    const dots = [-38, 0, 38].map((x, index) => layer(`dot ${index + 1}`, [group([ellipse(0, 0, 16), fill(C.harbor)])], {
        op,
        position: {
            a: 1,
            k: [
                { t: 0, s: [228 + x, 152, 0], ...ease },
                ...[0, 1, 2].flatMap(cycle => {
                    const base = (cycle * 30) + (index * 8);
                    return [{ t: base + 4, s: [228 + x, 140, 0], ...ease }, { t: base + 16, s: [228 + x, 152, 0], ...ease }];
                }),
                { t: 108 + (index * 4), s: [228 + x, 152, 0], i: { x: 0.6, y: 0.4 }, o: { x: 0.8, y: 0 } },
                { t: 150 + (index * 4), s: [228 + x + (index - 1) * 14, 300, 0], ...ease },
                { t: 212, s: [228 + x, 152, 0] },
            ],
        },
        opacity: anim([0, 100], [118 + index * 4, 100], [150 + index * 4, 0], [205, 0], [222, 100]),
    }));

    const sparkRays = [0, 60, 120, 180, 240, 300].map(angle => {
        const radians = (angle * Math.PI) / 180;
        return path([[Math.cos(radians) * 10, Math.sin(radians) * 10], [Math.cos(radians) * 22, Math.sin(radians) * 22]]);
    });
    const spark = layer('spark', [group([...sparkRays, stroke(C.ochre, 3)])], {
        op, position: [318, 92],
        scale: anim([0, [0, 0, 100]], [92, [0, 0, 100]], [100, [120, 120, 100]], [118, [0, 0, 100]]),
        rotation: anim([92, 0], [118, 40]),
    });

    const plug = layer('cable', [
        group([path([[60, 290], [120, 250], [150, 262]], false, [[0, 0], [-20, 10], [-10, 0]], [[20, -20], [10, -5], [0, 0]]), stroke(C.line, 3)]),
        group([rect(158, 262, 18, 12, 3), fill(C.ink)]),
    ], { op, position: [0, 0], opacity: anim([0, 0], [100, 0], [112, 100], [205, 100], [220, 0]) });

    return composition('Signal dropped', op, [plug, bubble, crack, ...dots, spark]);
}

function gearPath(teeth, outer, inner) {
    const vertices = [];
    const step = (Math.PI * 2) / teeth;
    for (let tooth = 0; tooth < teeth; tooth += 1) {
        const a = tooth * step;
        for (const [offset, radius] of [[-0.28, inner], [-0.15, outer], [0.15, outer], [0.28, inner]]) {
            vertices.push([Math.cos(a + offset * step) * radius, Math.sin(a + offset * step) * radius]);
        }
    }
    return path(vertices, true);
}

// Maintenance: two gears turn while a progress line sweeps underneath. The page lays the real
// brand mark (web/brand.css + Lucide megaphone) over the large gear's hub.
function maintenance() {
    const op = 240;
    const big = layer('large gear', [group([gearPath(12, 58, 48), fill(C.harborWash), stroke(C.harbor, 2.6)])],
        { op, position: [200, 150], rotation: anim([0, 0, linear], [op, 72]) });
    const small = layer('small gear', [group([gearPath(8, 38, 29), fill(C.sageWash), stroke(C.sage, 2.6)]), group([ellipse(0, 0, 20), fill(C.white), stroke(C.sage, 2.6)])],
        { op, position: [278, 112], rotation: anim([0, 360 / 16, linear], [op, (360 / 16) - ((72 * 12) / 8)]) });
    const track = layer('track', [group([path([[120, 262], [360, 262]]), stroke(C.line, 6)])], { op });
    const progress = layer('progress', [group([
        path([[120, 262], [360, 262]]),
        trim(anim([0, 0], [110, 100]), anim([0, 0], [40, 0], [150, 100])),
        stroke(C.harbor, 6),
    ])], { op });
    return composition('Tuning up', op, [track, progress, big, small]);
}

await mkdir(new URL('../web/animations/', import.meta.url), { recursive: true });
for (const [name, build] of [['lost-message', lostMessage], ['broken-signal', brokenSignal], ['maintenance', maintenance]]) {
    await writeFile(new URL(`../web/animations/${name}.json`, import.meta.url), JSON.stringify(build()));
    console.log(`web/animations/${name}.json`);
}
