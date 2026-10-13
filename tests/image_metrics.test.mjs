import assert from 'node:assert/strict';
import test from 'node:test';

import { compareHDR, evaluateHDRComparison } from '../src/image_metrics.ts';

const thresholds = {
    absoluteTolerance: 0.01,
    relativeTolerance: 0.1,
    displayTolerance: 4 / 255,
    coverageThreshold: 1e-4,
};

const gate = {
    label: 'unit-test raw and display gate',
    rawFractionScope: 'covered',
    minimumRawFractionWithinTolerance: 1,
    minimumDisplayedFractionWithinTolerance: 1,
    maximumDisplayedMeanAbsoluteRGBError: 4 / 255,
    maximumCoveredMeanNormalizedError: 1,
    requireCoveredPixels: true,
};

function close(actual, expected, tolerance = 1e-12) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${expected}, received ${actual}`,
    );
}

test('identical nonblack HDR images have zero error and pass both gates', () => {
    const image = new Float32Array([0.25, 2, 0.5, 1, 0, 0, 0, 0]);
    const metrics = compareHDR(image, image, thresholds);

    assert.equal(metrics.finite, true);
    assert.equal(metrics.totalPixels, 2);
    assert.equal(metrics.coveredPixels, 1);
    assert.equal(metrics.rawMeanAbsoluteRGBError, 0);
    assert.equal(metrics.rawMaximumAbsoluteRGBError, 0);
    assert.equal(metrics.meanRelativeRGBError, 0);
    assert.equal(metrics.meanNormalizedRGBError, 0);
    assert.equal(metrics.coveredMeanNormalizedRGBError, 0);
    assert.equal(metrics.rawFractionWithinToleranceAll, 1);
    assert.equal(metrics.rawFractionWithinToleranceCovered, 1);
    assert.equal(metrics.displayedMeanAbsoluteRGBError, 0);
    assert.equal(metrics.displayedMaximumAbsoluteRGBError, 0);
    assert.equal(metrics.displayedFractionWithinTolerance, 1);
    assert.equal(evaluateHDRComparison(metrics, gate).passed, true);
});

test('a single RGB channel contributes independently calculated raw and display errors', () => {
    const reference = [0.2, 0.4, 0.6, 1];
    const candidate = [0.3, 0.4, 0.6, 1];
    const metrics = compareHDR(reference, candidate, thresholds);

    close(metrics.rawMeanAbsoluteRGBError, 0.1 / 3);
    close(metrics.rawMaximumAbsoluteRGBError, 0.1);
    close(metrics.meanRelativeRGBError, (0.1 / 0.2) / 3);
    close(metrics.meanNormalizedRGBError, (0.1 / 0.03) / 3);
    close(metrics.coveredMeanNormalizedRGBError, (0.1 / 0.03) / 3);
    close(metrics.displayedMeanAbsoluteRGBError, 0.1 / 3);
    close(metrics.displayedMaximumAbsoluteRGBError, 0.1);
    assert.equal(metrics.rawFractionWithinToleranceAll, 0);
    assert.equal(metrics.rawFractionWithinToleranceCovered, 0);
    assert.equal(metrics.displayedFractionWithinTolerance, 0);
});

test('absolute plus relative budgets accept their boundary and reject larger errors', () => {
    const exactThresholds = {
        absoluteTolerance: 0.125,
        relativeTolerance: 0.25,
        displayTolerance: 4 / 255,
        coverageThreshold: 1e-4,
    };
    const reference = [2, 0.5, 0, 1];
    const accepted = [2.625, 0.75, 0.125, 1];
    const rejected = [2.625 + 1 / 1024, 0.75 + 1 / 1024, 0.125 + 1 / 1024, 1];

    const acceptedMetrics = compareHDR(reference, accepted, exactThresholds);
    assert.equal(acceptedMetrics.rawFractionWithinToleranceAll, 1);
    assert.equal(acceptedMetrics.rawFractionWithinToleranceCovered, 1);

    const rejectedMetrics = compareHDR(reference, rejected, exactThresholds);
    assert.equal(rejectedMetrics.rawFractionWithinToleranceAll, 0);
    assert.equal(rejectedMetrics.rawFractionWithinToleranceCovered, 0);
});

test('coverage is the union of reference and candidate illumination', () => {
    const missing = compareHDR([0.2, 0, 0, 1], [0, 0, 0, 1], thresholds);
    const newlyLit = compareHDR([0, 0, 0, 1], [0, 0.2, 0, 1], thresholds);

    assert.equal(missing.coveredPixels, 1);
    assert.equal(newlyLit.coveredPixels, 1);
    assert.equal(missing.rawFractionWithinToleranceCovered, 0);
    assert.equal(newlyLit.rawFractionWithinToleranceCovered, 0);
});

test('empty coverage reports a covered fraction of one without fabricating pixels', () => {
    const metrics = compareHDR([0, 0, 0, 1], [0, 0, 0, 1], thresholds);
    assert.equal(metrics.coveredPixels, 0);
    assert.equal(metrics.rawPixelsWithinToleranceCovered, 0);
    assert.equal(metrics.rawFractionWithinToleranceCovered, 1);
    assert.equal(evaluateHDRComparison(metrics, gate).passed, false);
});

test('invalid RGBA shapes and mismatched lengths throw', () => {
    assert.throws(() => compareHDR([], [], thresholds), /nonempty RGBA/);
    assert.throws(() => compareHDR([0, 0, 0], [0, 0, 0], thresholds), /divisible by four/);
    assert.throws(
        () => compareHDR([0, 0, 0, 1], [0, 0, 0, 1, 0, 0, 0, 1], thresholds),
        /lengths differ/,
    );
});

test('NaN and Infinity in RGB or alpha make the comparison finite gate fail', () => {
    const fixtures = [
        [Number.NaN, 0.2, 0.3, 1],
        [0.1, Number.POSITIVE_INFINITY, 0.3, 1],
        [0.1, 0.2, 0.3, Number.NEGATIVE_INFINITY],
    ];
    for (const candidate of fixtures) {
        const metrics = compareHDR([0.1, 0.2, 0.3, 1], candidate, thresholds);
        assert.equal(metrics.finite, false);
        assert.equal(evaluateHDRComparison(metrics, gate).passed, false);
    }
});

test('display-clamped equality cannot hide a catastrophic raw HDR mismatch', () => {
    const reference = [4, 2, 1, 1];
    const candidate = [40, 20, 10, 1];
    const metrics = compareHDR(reference, candidate, thresholds);
    const decision = evaluateHDRComparison(metrics, gate);

    assert.equal(metrics.displayedMeanAbsoluteRGBError, 0);
    assert.equal(metrics.displayedMaximumAbsoluteRGBError, 0);
    assert.equal(metrics.displayedFractionWithinTolerance, 1);
    assert.equal(metrics.rawFractionWithinToleranceAll, 0);
    assert.equal(metrics.rawFractionWithinToleranceCovered, 0);
    assert.equal(decision.checks.displayedFraction, true);
    assert.equal(decision.checks.rawFraction, false);
    assert.equal(decision.passed, false);
});

test('covered normalized error is not diluted by a large black background', () => {
    const pixelCount = 101;
    const reference = new Float32Array(pixelCount * 4);
    const candidate = new Float32Array(pixelCount * 4);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        reference[pixel * 4 + 3] = 1;
        candidate[pixel * 4 + 3] = 1;
    }
    reference[0] = 1;
    candidate[0] = 1.22;

    const metrics = compareHDR(reference, candidate, thresholds);
    const normalizedRedError = 0.22 / 0.11;
    close(metrics.meanNormalizedRGBError, normalizedRedError / (pixelCount * 3), 1e-6);
    close(metrics.coveredMeanNormalizedRGBError, normalizedRedError / 3, 1e-6);
    assert.equal(metrics.coveredPixels, 1);
    assert.ok(metrics.coveredMeanNormalizedRGBError > metrics.meanNormalizedRGBError * 100);
});
