export interface HDRComparisonThresholds {
    readonly absoluteTolerance: number;
    readonly relativeTolerance: number;
    readonly displayTolerance: number;
    readonly coverageThreshold: number;
}

export interface HDRComparisonMetrics {
    readonly finite: boolean;
    readonly totalPixels: number;
    readonly coveredPixels: number;
    readonly rawMeanAbsoluteRGBError: number;
    readonly rawMaximumAbsoluteRGBError: number;
    readonly meanRelativeRGBError: number;
    readonly meanNormalizedRGBError: number;
    readonly coveredMeanNormalizedRGBError: number;
    readonly rawPixelsWithinToleranceAll: number;
    readonly rawPixelsWithinToleranceCovered: number;
    readonly rawFractionWithinToleranceAll: number;
    readonly rawFractionWithinToleranceCovered: number;
    readonly displayedMeanAbsoluteRGBError: number;
    readonly displayedMaximumAbsoluteRGBError: number;
    readonly displayedPixelsWithinTolerance: number;
    readonly displayedFractionWithinTolerance: number;
    readonly thresholds: HDRComparisonThresholds;
}

export interface HDRComparisonGate {
    readonly label: string;
    readonly rawFractionScope: 'all' | 'covered';
    readonly minimumRawFractionWithinTolerance: number;
    readonly minimumDisplayedFractionWithinTolerance: number;
    readonly maximumDisplayedMeanAbsoluteRGBError: number;
    readonly maximumCoveredMeanNormalizedError?: number;
    readonly requireCoveredPixels?: boolean;
}

export interface HDRComparisonGateResult {
    readonly passed: boolean;
    readonly policy: HDRComparisonGate;
    readonly checks: {
        readonly finite: boolean;
        readonly coverage: boolean;
        readonly rawFraction: boolean;
        readonly displayedFraction: boolean;
        readonly displayedMean: boolean;
        readonly coveredNormalizedMean: boolean;
    };
    readonly failures: readonly string[];
}

function requireFiniteNonnegative(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a finite nonnegative number`);
    }
}

function requireFraction(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${name} must be a finite number in [0, 1]`);
    }
}

function validateInputs(
    reference: ArrayLike<number>,
    candidate: ArrayLike<number>,
    thresholds: HDRComparisonThresholds,
): number {
    if (!Number.isSafeInteger(reference.length) || reference.length <= 0 || reference.length % 4 !== 0) {
        throw new Error('Reference image must be a nonempty RGBA array with length divisible by four');
    }
    if (!Number.isSafeInteger(candidate.length) || candidate.length <= 0 || candidate.length % 4 !== 0) {
        throw new Error('Candidate image must be a nonempty RGBA array with length divisible by four');
    }
    if (reference.length !== candidate.length) {
        throw new Error(`Image lengths differ: reference=${reference.length}, candidate=${candidate.length}`);
    }
    requireFiniteNonnegative(thresholds.absoluteTolerance, 'absoluteTolerance');
    requireFiniteNonnegative(thresholds.relativeTolerance, 'relativeTolerance');
    requireFiniteNonnegative(thresholds.displayTolerance, 'displayTolerance');
    requireFiniteNonnegative(thresholds.coverageThreshold, 'coverageThreshold');
    return reference.length / 4;
}

function clampDisplay(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * Compares linear HDR RGBA images. Error statistics use RGB; `finite` covers
 * every RGB and alpha component so invalid alpha cannot produce a passing row.
 */
export function compareHDR(
    reference: ArrayLike<number>,
    candidate: ArrayLike<number>,
    thresholds: HDRComparisonThresholds,
): HDRComparisonMetrics {
    const totalPixels = validateInputs(reference, candidate, thresholds);
    let finite = true;
    let coveredPixels = 0;
    let rawAbsoluteSum = 0;
    let rawMaximumAbsoluteRGBError = 0;
    let relativeSum = 0;
    let normalizedSum = 0;
    let coveredNormalizedSum = 0;
    let rawPixelsWithinToleranceAll = 0;
    let rawPixelsWithinToleranceCovered = 0;
    let displayedAbsoluteSum = 0;
    let displayedMaximumAbsoluteRGBError = 0;
    let displayedPixelsWithinTolerance = 0;

    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
        const base = pixel * 4;
        let covered = false;
        let rawPixelWithinTolerance = true;
        let displayedPixelWithinTolerance = true;
        let pixelNormalizedSum = 0;

        for (let component = 0; component < 4; component += 1) {
            const referenceValue = Number(reference[base + component]);
            const candidateValue = Number(candidate[base + component]);
            if (!Number.isFinite(referenceValue) || !Number.isFinite(candidateValue)) {
                finite = false;
            }
            if (component === 3) {
                continue;
            }

            const pairFinite = Number.isFinite(referenceValue) && Number.isFinite(candidateValue);
            if (!pairFinite
                || Math.abs(referenceValue) > thresholds.coverageThreshold
                || Math.abs(candidateValue) > thresholds.coverageThreshold) {
                covered = true;
            }

            const rawDifference = pairFinite
                ? Math.abs(referenceValue - candidateValue)
                : Number.POSITIVE_INFINITY;
            rawAbsoluteSum += rawDifference;
            rawMaximumAbsoluteRGBError = Math.max(rawMaximumAbsoluteRGBError, rawDifference);

            const relativeDenominator = Math.max(
                Math.abs(referenceValue),
                thresholds.coverageThreshold,
                Number.EPSILON,
            );
            relativeSum += rawDifference / relativeDenominator;

            const budget = thresholds.absoluteTolerance
                + thresholds.relativeTolerance * Math.abs(referenceValue);
            const normalizedError = budget > 0
                ? rawDifference / budget
                : (rawDifference === 0 ? 0 : Number.POSITIVE_INFINITY);
            normalizedSum += normalizedError;
            pixelNormalizedSum += normalizedError;
            if (!pairFinite || rawDifference > budget) {
                rawPixelWithinTolerance = false;
            }

            const displayedDifference = pairFinite
                ? Math.abs(clampDisplay(referenceValue) - clampDisplay(candidateValue))
                : Number.POSITIVE_INFINITY;
            displayedAbsoluteSum += displayedDifference;
            displayedMaximumAbsoluteRGBError = Math.max(
                displayedMaximumAbsoluteRGBError,
                displayedDifference,
            );
            if (!pairFinite || displayedDifference > thresholds.displayTolerance) {
                displayedPixelWithinTolerance = false;
            }
        }

        if (rawPixelWithinTolerance) {
            rawPixelsWithinToleranceAll += 1;
        }
        if (displayedPixelWithinTolerance) {
            displayedPixelsWithinTolerance += 1;
        }
        if (covered) {
            coveredPixels += 1;
            coveredNormalizedSum += pixelNormalizedSum;
            if (rawPixelWithinTolerance) {
                rawPixelsWithinToleranceCovered += 1;
            }
        }
    }

    const rgbComponentCount = totalPixels * 3;
    const coveredRGBComponentCount = coveredPixels * 3;
    return {
        finite,
        totalPixels,
        coveredPixels,
        rawMeanAbsoluteRGBError: rawAbsoluteSum / rgbComponentCount,
        rawMaximumAbsoluteRGBError,
        meanRelativeRGBError: relativeSum / rgbComponentCount,
        meanNormalizedRGBError: normalizedSum / rgbComponentCount,
        coveredMeanNormalizedRGBError: coveredPixels === 0
            ? 0
            : coveredNormalizedSum / coveredRGBComponentCount,
        rawPixelsWithinToleranceAll,
        rawPixelsWithinToleranceCovered,
        rawFractionWithinToleranceAll: rawPixelsWithinToleranceAll / totalPixels,
        rawFractionWithinToleranceCovered: coveredPixels === 0
            ? 1
            : rawPixelsWithinToleranceCovered / coveredPixels,
        displayedMeanAbsoluteRGBError: displayedAbsoluteSum / rgbComponentCount,
        displayedMaximumAbsoluteRGBError,
        displayedPixelsWithinTolerance,
        displayedFractionWithinTolerance: displayedPixelsWithinTolerance / totalPixels,
        thresholds: { ...thresholds },
    };
}

/** Applies one declared policy that always checks finite, raw, and display data. */
export function evaluateHDRComparison(
    metrics: HDRComparisonMetrics,
    policy: HDRComparisonGate,
): HDRComparisonGateResult {
    if (policy.label.length === 0) {
        throw new Error('HDR comparison gate label must not be empty');
    }
    requireFraction(
        policy.minimumRawFractionWithinTolerance,
        'minimumRawFractionWithinTolerance',
    );
    requireFraction(
        policy.minimumDisplayedFractionWithinTolerance,
        'minimumDisplayedFractionWithinTolerance',
    );
    requireFiniteNonnegative(
        policy.maximumDisplayedMeanAbsoluteRGBError,
        'maximumDisplayedMeanAbsoluteRGBError',
    );
    if (policy.maximumCoveredMeanNormalizedError !== undefined) {
        requireFiniteNonnegative(
            policy.maximumCoveredMeanNormalizedError,
            'maximumCoveredMeanNormalizedError',
        );
    }

    const rawFraction = policy.rawFractionScope === 'all'
        ? metrics.rawFractionWithinToleranceAll
        : metrics.rawFractionWithinToleranceCovered;
    const checks = {
        finite: metrics.finite,
        coverage: !policy.requireCoveredPixels || metrics.coveredPixels > 0,
        rawFraction: Number.isFinite(rawFraction)
            && rawFraction >= policy.minimumRawFractionWithinTolerance,
        displayedFraction: Number.isFinite(metrics.displayedFractionWithinTolerance)
            && metrics.displayedFractionWithinTolerance
                >= policy.minimumDisplayedFractionWithinTolerance,
        displayedMean: Number.isFinite(metrics.displayedMeanAbsoluteRGBError)
            && metrics.displayedMeanAbsoluteRGBError
                <= policy.maximumDisplayedMeanAbsoluteRGBError,
        coveredNormalizedMean: policy.maximumCoveredMeanNormalizedError === undefined
            || (Number.isFinite(metrics.coveredMeanNormalizedRGBError)
                && metrics.coveredMeanNormalizedRGBError
                    <= policy.maximumCoveredMeanNormalizedError),
    };

    const failures: string[] = [];
    if (!checks.finite) failures.push('one or more RGBA components are non-finite');
    if (!checks.coverage) failures.push('the comparison has no covered pixels');
    if (!checks.rawFraction) {
        failures.push(
            `${policy.rawFractionScope} raw fraction ${rawFraction} is below `
            + policy.minimumRawFractionWithinTolerance,
        );
    }
    if (!checks.displayedFraction) {
        failures.push(
            `displayed fraction ${metrics.displayedFractionWithinTolerance} is below `
            + policy.minimumDisplayedFractionWithinTolerance,
        );
    }
    if (!checks.displayedMean) {
        failures.push(
            `displayed mean error ${metrics.displayedMeanAbsoluteRGBError} exceeds `
            + policy.maximumDisplayedMeanAbsoluteRGBError,
        );
    }
    if (!checks.coveredNormalizedMean) {
        failures.push(
            `covered normalized mean ${metrics.coveredMeanNormalizedRGBError} exceeds `
            + policy.maximumCoveredMeanNormalizedError,
        );
    }

    return {
        passed: Object.values(checks).every(Boolean),
        policy: { ...policy },
        checks,
        failures,
    };
}
