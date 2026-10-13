import assert from 'node:assert/strict';
import test from 'node:test';

import {
    boundsForCluster,
    decodeOct,
    encodeOct,
    flatten,
    multiplyPoint,
    sliceBoundary,
    sliceIndex,
    sphereIntersects,
    unflatten,
} from '../src/cluster_math.ts';

const supportedGrids = [
    [8, 4, 16],
    [16, 9, 24],
    [32, 18, 24],
];

function assertClose(actual, expected, tolerance, message) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${message}: expected ${expected}, received ${actual}`,
    );
}

function normalize(vector) {
    const length = Math.hypot(...vector);
    return vector.map(component => component / length);
}

function assertPointInside(bounds, point, message) {
    for (let axis = 0; axis < 3; axis++) {
        assert.ok(
            point[axis] >= bounds[axis] && point[axis] <= bounds[axis + 3],
            `${message}: axis ${axis}, point ${point[axis]}, bounds [${bounds[axis]}, ${bounds[axis + 3]}]`,
        );
    }
}

function assertConservativeBounds(bounds, expectedMinimum, expectedMaximum, farDistance) {
    assert.equal(bounds.length, 6);
    const maximumMargin = farDistance * 0.01;
    for (let axis = 0; axis < 3; axis++) {
        assert.ok(bounds[axis] <= expectedMinimum[axis], `minimum axis ${axis} must be conservative`);
        assert.ok(bounds[axis + 3] >= expectedMaximum[axis], `maximum axis ${axis} must be conservative`);
        assert.ok(expectedMinimum[axis] - bounds[axis] < maximumMargin, `minimum axis ${axis} expanded too far`);
        assert.ok(bounds[axis + 3] - expectedMaximum[axis] < maximumMargin, `maximum axis ${axis} expanded too far`);
    }
}

function quantizeSnorm16(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    const integer = Math.max(-32767, Math.min(32767, Math.round(clamped * 32767)));
    return integer / 32767;
}

function angularErrorDegrees(left, right) {
    const dot = left.reduce((sum, component, index) => sum + component * right[index], 0);
    return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function assertOctRoundTrip(normal, label) {
    const encoded = encodeOct(normal);
    for (const component of encoded) {
        assert.ok(Number.isFinite(component), `${label}: encoded component must be finite`);
        assert.ok(component >= -1 && component <= 1, `${label}: encoded component ${component} is outside [-1, 1]`);
    }

    const quantized = encoded.map(quantizeSnorm16);
    const decoded = decodeOct(quantized);
    for (const component of decoded) {
        assert.ok(Number.isFinite(component), `${label}: decoded component must be finite`);
    }
    assertClose(Math.hypot(...decoded), 1, 1e-12, `${label}: decoded length`);
    const error = angularErrorDegrees(normal, decoded);
    assert.ok(error <= 0.02, `${label}: angular error ${error} degrees exceeds 0.02 degrees`);
    return error;
}

test('flatten has independent known linear-index results', () => {
    assert.equal(flatten(5, 2, 7, [8, 4, 16]), 245);
    assert.equal(flatten(11, 5, 13, [16, 9, 24]), 1963);
    assert.equal(flatten(17, 11, 7, [32, 18, 24]), 4401);
});

test('flatten and unflatten are a bijection over every supported grid', () => {
    for (const dimensions of supportedGrids) {
        const total = dimensions[0] * dimensions[1] * dimensions[2];
        const visited = new Set();

        for (let z = 0; z < dimensions[2]; z++) {
            for (let y = 0; y < dimensions[1]; y++) {
                for (let x = 0; x < dimensions[0]; x++) {
                    const index = flatten(x, y, z, dimensions);
                    assert.ok(index >= 0 && index < total, `${dimensions}: index ${index} is out of range`);
                    assert.equal(visited.has(index), false, `${dimensions}: duplicate index ${index}`);
                    visited.add(index);
                    assert.deepEqual(unflatten(index, dimensions), [x, y, z]);
                }
            }
        }

        assert.equal(visited.size, total);
        for (let index = 0; index < total; index++) {
            assert.equal(visited.has(index), true, `${dimensions}: missing index ${index}`);
        }
    }
});

test('logarithmic slice boundaries include endpoints with geometric spacing', () => {
    const near = 0.1;
    const far = 1000;
    for (const slices of [16, 24]) {
        assertClose(sliceBoundary(0, slices, near, far), near, 1e-14, `${slices} slices near endpoint`);
        assertClose(sliceBoundary(slices, slices, near, far), far, 1e-10, `${slices} slices far endpoint`);

        const expectedRatio = (far / near) ** (1 / slices);
        for (let index = 1; index <= slices; index++) {
            const ratio = sliceBoundary(index, slices, near, far)
                / sliceBoundary(index - 1, slices, near, far);
            assertClose(ratio, expectedRatio, expectedRatio * 1e-12, `${slices} slices ratio ${index}`);
        }
    }
});

test('slice indices select every geometric midpoint and clamp distance extremes', () => {
    const near = 0.1;
    const far = 1000;
    for (const slices of [16, 24]) {
        for (let index = 0; index < slices; index++) {
            const lower = sliceBoundary(index, slices, near, far);
            const upper = sliceBoundary(index + 1, slices, near, far);
            const midpoint = Math.sqrt(lower * upper);
            assert.equal(sliceIndex(midpoint, slices, near, far), index);
        }

        for (const distance of [-100, -1, 0, near / 2, near]) {
            assert.equal(sliceIndex(distance, slices, near, far), 0);
        }
        for (const distance of [far, far * 2, Number.POSITIVE_INFINITY]) {
            assert.equal(sliceIndex(distance, slices, near, far), slices - 1);
        }
    }
});

test('slice indices change on each internal logarithmic boundary', () => {
    const near = 0.1;
    const far = 1000;
    const relativeOffset = 1e-8;

    for (const slices of [16, 24]) {
        for (let index = 1; index < slices; index++) {
            const boundary = sliceBoundary(index, slices, near, far);
            const atBoundary = sliceIndex(boundary, slices, near, far);
            assert.ok(
                atBoundary === index || atBoundary === index - 1,
                `${slices} slices boundary ${index} produced ${atBoundary}`,
            );
            assert.equal(sliceIndex(boundary * (1 - relativeOffset), slices, near, far), index - 1);
            assert.equal(sliceIndex(boundary * (1 + relativeOffset), slices, near, far), index);
        }
    }
});

test('sphere/AABB intersection includes exact face, edge, and corner tangencies', () => {
    const bounds = [-1, -1, -1, 1, 1, 1];

    for (let axis = 0; axis < 3; axis++) {
        const positive = [0, 0, 0];
        positive[axis] = 2;
        assert.equal(sphereIntersects(positive, 1, bounds), true, `positive face on axis ${axis}`);

        const negative = [0, 0, 0];
        negative[axis] = -2;
        assert.equal(sphereIntersects(negative, 1, bounds), true, `negative face on axis ${axis}`);

        positive[axis] += 1e-6;
        negative[axis] -= 1e-6;
        assert.equal(sphereIntersects(positive, 1, bounds), false, `outside positive face on axis ${axis}`);
        assert.equal(sphereIntersects(negative, 1, bounds), false, `outside negative face on axis ${axis}`);
    }

    assert.equal(sphereIntersects([4, 5, 0], 5, bounds), true, '3-4-5 edge tangency');
    assert.equal(sphereIntersects([4, 5 + 1e-6, 0], 5, bounds), false, 'outside 3-4-5 edge');
    assert.equal(sphereIntersects([2, 3, 3], 3, bounds), true, '1-2-2 corner tangency');
    assert.equal(sphereIntersects([2, 3, 3 + 1e-6], 3, bounds), false, 'outside 1-2-2 corner');
    assert.equal(sphereIntersects([0, 0, 0], 0, bounds), true, 'zero-radius interior point');
    assert.equal(sphereIntersects([1, 0, 0], 0, bounds), true, 'zero-radius face point');
    assert.equal(sphereIntersects([1 + 1e-12, 0, 0], 0, bounds), false, 'zero-radius outside point');
});

test('sphere/AABB results are preserved when both operands are translated', () => {
    const translation = [7, -5, 11];
    const bounds = [-1, -1, -1, 1, 1, 1];
    const translatedBounds = [
        bounds[0] + translation[0],
        bounds[1] + translation[1],
        bounds[2] + translation[2],
        bounds[3] + translation[0],
        bounds[4] + translation[1],
        bounds[5] + translation[2],
    ];
    const cases = [
        { center: [2, 0, 0], radius: 1, expected: true },
        { center: [0, -2, 0], radius: 1, expected: true },
        { center: [0, 0, 2 + 1e-6], radius: 1, expected: false },
        { center: [4, 5, 0], radius: 5, expected: true },
        { center: [2, 3, 3], radius: 3, expected: true },
        { center: [0, 0, 0], radius: 0, expected: true },
    ];

    for (const { center, radius, expected } of cases) {
        const translatedCenter = center.map((component, axis) => component + translation[axis]);
        assert.equal(sphereIntersects(center, radius, bounds), expected);
        assert.equal(sphereIntersects(translatedCenter, radius, translatedBounds), expected);
    }
});

const analyticalInverseProjection = [
    2, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, -8 / 9,
    0, 0, -1, 1,
];

test('multiplyPoint applies the analytical inverse projection in column-major order', () => {
    const result = multiplyPoint(analyticalInverseProjection, [0.25, -0.5, 1, 1]);
    const expected = [0.5, -0.5, -1, 1 / 9];
    for (let axis = 0; axis < 4; axis++) {
        assertClose(result[axis], expected[axis], 1e-14, `homogeneous component ${axis}`);
    }
});

test('boundsForCluster contains the analytical upper-left near-slice frustum corners', () => {
    const dimensions = [2, 2, 2];
    const index = flatten(0, 0, 0, dimensions);
    const bounds = boundsForCluster(index, dimensions, analyticalInverseProjection, 1, 9);
    const corners = [
        [-2, 1, -1], [-2, 0, -1], [0, 1, -1], [0, 0, -1],
        [-6, 3, -3], [-6, 0, -3], [0, 3, -3], [0, 0, -3],
    ];

    for (const [cornerIndex, point] of corners.entries()) {
        assertPointInside(bounds, point, `upper-left corner ${cornerIndex}`);
    }
    assertConservativeBounds(bounds, [-6, 0, -3], [0, 3, -1], 3);
});

test('boundsForCluster handles the lower-right far slice, Y flip, and negative view Z', () => {
    const dimensions = [2, 2, 2];
    const index = flatten(1, 1, 1, dimensions);
    const bounds = boundsForCluster(index, dimensions, analyticalInverseProjection, 1, 9);
    const corners = [
        [0, 0, -3], [6, 0, -3], [0, -3, -3], [6, -3, -3],
        [0, 0, -9], [18, 0, -9], [0, -9, -9], [18, -9, -9],
    ];

    for (const [cornerIndex, point] of corners.entries()) {
        assertPointInside(bounds, point, `lower-right corner ${cornerIndex}`);
    }
    assertConservativeBounds(bounds, [0, -9, -9], [18, 0, -3], 9);
});

test('octahedral encoding has exact axis mappings including negative Z', () => {
    const axisCases = [
        { normal: [1, 0, 0], encoded: [1, 0] },
        { normal: [-1, 0, 0], encoded: [-1, 0] },
        { normal: [0, 1, 0], encoded: [0, 1] },
        { normal: [0, -1, 0], encoded: [0, -1] },
        { normal: [0, 0, 1], encoded: [0, 0] },
        { normal: [0, 0, -1], encoded: [1, 1] },
    ];

    for (const { normal, encoded } of axisCases) {
        assert.deepEqual(encodeOct(normal), encoded);
        assertOctRoundTrip(normal, `axis ${normal}`);
    }
});

test('octahedral round trips remain stable across signed-zero and lower-hemisphere seams', () => {
    const signedZeroSouthPoles = [
        [0, 0, -1],
        [-0, 0, -1],
        [0, -0, -1],
        [-0, -0, -1],
    ];
    for (const normal of signedZeroSouthPoles) {
        assert.deepEqual(encodeOct(normal), [1, 1]);
        assertOctRoundTrip(normal, `signed-zero south pole ${normal}`);
    }

    const epsilon = 1e-9;
    const seamNormals = [
        [epsilon, epsilon, -1],
        [-epsilon, epsilon, -1],
        [epsilon, -epsilon, -1],
        [-epsilon, -epsilon, -1],
        [1, 0, -epsilon],
        [-1, -0, -epsilon],
        [0, 1, -epsilon],
        [-0, -1, -epsilon],
        [1, 1, -epsilon],
        [-1, 1, -epsilon],
        [1, -1, -epsilon],
        [-1, -1, -epsilon],
    ].map(normalize);

    for (const [index, normal] of seamNormals.entries()) {
        assertOctRoundTrip(normal, `lower-hemisphere seam ${index}`);
    }
});

test('SNORM16 octahedral round trips stay within 0.02 degrees for seeded unit vectors', () => {
    let state = 0x5eed1234;
    const nextRandom = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };

    const sampleCount = 2048;
    let lowerHemisphereSamples = 0;
    let maximumError = 0;
    for (let index = 0; index < sampleCount; index++) {
        const z = nextRandom() * 2 - 1;
        const azimuth = nextRandom() * 2 * Math.PI;
        const radial = Math.sqrt(Math.max(0, 1 - z * z));
        const normal = [radial * Math.cos(azimuth), radial * Math.sin(azimuth), z];
        if (z < 0) {
            lowerHemisphereSamples++;
        }
        maximumError = Math.max(maximumError, assertOctRoundTrip(normal, `sample ${index}`));
    }

    assert.ok(lowerHemisphereSamples >= 900, `only ${lowerHemisphereSamples} lower-hemisphere samples`);
    assert.ok(maximumError > 0, 'quantized samples should exercise nonzero angular error');
});
