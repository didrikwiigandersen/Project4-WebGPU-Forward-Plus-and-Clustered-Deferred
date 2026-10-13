import type { Configuration, ProjectApp } from './app_api';
import { saveEvidence } from './app_api';
import { boundsForCluster, flatten, multiplyPoint, sliceIndex, sphereIntersects } from './cluster_math';
import { readBuffer, readHDR, readTexture, canvasPixels } from './gpu_io';
import {
    compareHDR,
    evaluateHDRComparison,
    type HDRComparisonGate,
    type HDRComparisonMetrics,
    type HDRComparisonThresholds,
} from './image_metrics';
import { validatePacking } from './packing_validation';
import { profiler } from './profiler';
import { canvas, device } from './renderer';
import { ForwardPlusRenderer } from './renderers/forward_plus';
import { settings } from './settings';
import { Camera } from './stage/camera';

interface ValidationRow {
    readonly name: string;
    readonly passed: boolean;
    readonly metrics?: unknown;
    readonly error?: string;
}

interface ComparisonEvidence {
    readonly gateLabel: string;
    readonly metrics: HDRComparisonMetrics;
    readonly gate: ReturnType<typeof evaluateHDRComparison>;
}

interface RenderSnapshot {
    readonly hdr: Float32Array;
    readonly presented: Uint8Array;
    readonly bloom?: Float32Array;
}

class ValidationFailure extends Error {
    constructor(message: string, readonly evidence?: unknown) {
        super(message);
        this.name = 'ValidationFailure';
    }
}

function assert(condition: boolean, message: string, evidence?: unknown): asserts condition {
    if (!condition) throw new ValidationFailure(message, evidence);
}

const strictThresholds: HDRComparisonThresholds = {
    absoluteTolerance: 1e-4,
    relativeTolerance: 1e-3,
    displayTolerance: 4 / 255,
    coverageThreshold: 1e-4,
};

const encodingThresholds: HDRComparisonThresholds = {
    absoluteTolerance: 0.003,
    relativeTolerance: 0.03,
    displayTolerance: 4 / 255,
    coverageThreshold: 1e-4,
};

const cameraChangeThresholds: HDRComparisonThresholds = {
    absoluteTolerance: 1e-4,
    relativeTolerance: 1e-3,
    displayTolerance: 1 / 255,
    coverageThreshold: 1e-4,
};

const strictGate: HDRComparisonGate = {
    label: 'strict same-path raw HDR parity',
    rawFractionScope: 'all',
    minimumRawFractionWithinTolerance: 0.99999,
    minimumDisplayedFractionWithinTolerance: 0.99999,
    maximumDisplayedMeanAbsoluteRGBError: 1 / 255,
    requireCoveredPixels: true,
};

const coplanarTieGate: HDRComparisonGate = {
    label: 'depth-prepass coplanar-tie parity',
    rawFractionScope: 'all',
    minimumRawFractionWithinTolerance: 0.9995,
    minimumDisplayedFractionWithinTolerance: 0.99,
    maximumDisplayedMeanAbsoluteRGBError: 2 / 255,
    requireCoveredPixels: true,
};

const encodingGate: HDRComparisonGate = {
    label: 'quantized deferred G-buffer parity',
    rawFractionScope: 'covered',
    minimumRawFractionWithinTolerance: 0.99,
    minimumDisplayedFractionWithinTolerance: 0.99,
    maximumDisplayedMeanAbsoluteRGBError: 2 / 255,
    maximumCoveredMeanNormalizedError: 0.25,
    requireCoveredPixels: true,
};

const deterministicBase: Configuration = {
    mode: 'naive',
    lightCount: 1024,
    width: 480,
    height: 270,
    cameraPreset: 'Atrium',
    freezeLights: true,
    fixedTime: 1000,
    bloom: false,
    bloomThreshold: 1,
    bloomStrength: 0.2,
    debugView: 'none',
    bundles: false,
    clusterGrid: '16x9x24',
    depthMode: 'off',
    deferredCompute: false,
    compactGBuffer: false,
    optimizedLightMath: false,
};

function configureDeterministic(app: ProjectApp, configuration: Configuration = {}): void {
    app.configure({ ...deterministicBase, ...configuration });
    app.pause();
}

async function renderHDRFrame(app: ProjectApp): Promise<Float32Array> {
    app.render();
    return readHDR(app.renderer.outputTexture);
}

async function renderSnapshot(app: ProjectApp, includeBloom: boolean): Promise<RenderSnapshot> {
    app.render();
    // canvasPixels acquires the current swap-chain texture synchronously. Start
    // it before any await or offscreen readback can advance presentation.
    const presentedPromise = canvasPixels();
    const hdrPromise = readHDR(app.renderer.outputTexture);
    if (includeBloom) {
        const bloomPromise = readHDR(app.renderer.bloomTexture);
        const [presented, hdr, bloom] = await Promise.all([
            presentedPromise,
            hdrPromise,
            bloomPromise,
        ]);
        return { hdr, presented, bloom };
    }
    const [presented, hdr] = await Promise.all([presentedPromise, hdrPromise]);
    return { hdr, presented };
}

function comparisonEvidence(
    reference: ArrayLike<number>,
    candidate: ArrayLike<number>,
    thresholds: HDRComparisonThresholds,
    gatePolicy: HDRComparisonGate,
): ComparisonEvidence {
    const metrics = compareHDR(reference, candidate, thresholds);
    return {
        gateLabel: gatePolicy.label,
        metrics,
        gate: evaluateHDRComparison(metrics, gatePolicy),
    };
}

function requireComparison(
    reference: ArrayLike<number>,
    candidate: ArrayLike<number>,
    thresholds: HDRComparisonThresholds,
    gatePolicy: HDRComparisonGate,
): ComparisonEvidence {
    const evidence = comparisonEvidence(reference, candidate, thresholds, gatePolicy);
    assert(
        evidence.gate.passed,
        `${gatePolicy.label} failed: ${evidence.gate.failures.join('; ')}`,
        evidence,
    );
    return evidence;
}

function requireImage(image: Float32Array | undefined, name: string): Float32Array {
    assert(image !== undefined, `${name} was not captured because an earlier validation row failed`);
    return image;
}

function analyzeRGB(values: ArrayLike<number>): {
    finite: boolean;
    pixels: number;
    nonzeroPixels: number;
    energy: number;
    maximum: number;
} {
    assert(values.length > 0 && values.length % 4 === 0, 'RGBA analysis received an invalid shape');
    let finite = true;
    let nonzeroPixels = 0;
    let energy = 0;
    let maximum = 0;
    for (let pixel = 0; pixel < values.length; pixel += 4) {
        let nonzero = false;
        for (let channel = 0; channel < 4; channel += 1) {
            const value = Number(values[pixel + channel]);
            finite &&= Number.isFinite(value);
            if (channel < 3) {
                energy += value;
                maximum = Math.max(maximum, value);
                nonzero ||= value !== 0;
            }
        }
        if (nonzero) nonzeroPixels += 1;
    }
    return { finite, pixels: values.length / 4, nonzeroPixels, energy, maximum };
}

function comparePresented(reference: Uint8Array, candidate: Uint8Array): {
    pixels: number;
    changedPixels: number;
    changedRGBBytes: number;
    meanAbsoluteRGBError: number;
    maximumRGBError: number;
} {
    assert(
        reference.length === candidate.length && reference.length > 0 && reference.length % 4 === 0,
        'Presented image shapes differ',
    );
    let changedPixels = 0;
    let changedRGBBytes = 0;
    let absoluteError = 0;
    let maximumRGBError = 0;
    for (let pixel = 0; pixel < reference.length; pixel += 4) {
        let changed = false;
        for (let channel = 0; channel < 3; channel += 1) {
            const difference = Math.abs(reference[pixel + channel] - candidate[pixel + channel]);
            if (difference !== 0) {
                changed = true;
                changedRGBBytes += 1;
            }
            absoluteError += difference / 255;
            maximumRGBError = Math.max(maximumRGBError, difference / 255);
        }
        if (changed) changedPixels += 1;
    }
    return {
        pixels: reference.length / 4,
        changedPixels,
        changedRGBBytes,
        meanAbsoluteRGBError: absoluteError / (reference.length / 4 * 3),
        maximumRGBError,
    };
}

function arraysEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

async function validateCameraUniforms(app: ProjectApp, grid: string): Promise<object> {
    configureDeterministic(app, { mode: 'forward+', clusterGrid: grid });
    app.render();
    const expectedByteLength = 304;
    assert(app.camera.uniformsBuffer.size === expectedByteLength,
        `Camera GPU buffer is ${app.camera.uniformsBuffer.size} bytes, expected ${expectedByteLength}`);
    assert(app.camera.uniforms.buffer.byteLength === expectedByteLength,
        `Camera CPU mirror is ${app.camera.uniforms.buffer.byteLength} bytes, expected ${expectedByteLength}`);
    const gpuData = await readBuffer(app.camera.uniformsBuffer, expectedByteLength);
    assert(gpuData.byteLength === expectedByteLength, `Camera readback was ${gpuData.byteLength} bytes`);

    const cpuBytes = new Uint8Array(app.camera.uniforms.buffer);
    const gpuBytes = new Uint8Array(gpuData);
    for (let byte = 0; byte < expectedByteLength; byte += 1) {
        assert(gpuBytes[byte] === cpuBytes[byte],
            `Camera ABI differs at byte ${byte}: GPU=${gpuBytes[byte]}, CPU=${cpuBytes[byte]}`);
    }

    const floats = new Float32Array(gpuData);
    const uints = new Uint32Array(gpuData);
    const dimensions = app.lights.clusterDimensions;
    const viewport = Array.from(floats.slice(64, 68));
    const depth = Array.from(floats.slice(68, 72));
    const clusterFields = Array.from(uints.slice(72, 76));
    assert(viewport.every(Number.isFinite), `Camera viewport contains non-finite values: ${viewport}`);
    assert(depth.every(Number.isFinite), `Camera depth contains non-finite values: ${depth}`);
    assert(viewport[0] === Math.fround(canvas.width), `Camera viewport width ${viewport[0]} != ${canvas.width}`);
    assert(viewport[1] === Math.fround(canvas.height), `Camera viewport height ${viewport[1]} != ${canvas.height}`);
    assert(viewport[2] === Math.fround(1 / canvas.width), 'Camera reciprocal viewport width is incorrect');
    assert(viewport[3] === Math.fround(1 / canvas.height), 'Camera reciprocal viewport height is incorrect');
    assert(depth[0] === Math.fround(Camera.nearPlane), `Camera near plane ${depth[0]} is incorrect`);
    assert(depth[1] === Math.fround(Camera.farPlane), `Camera far plane ${depth[1]} is incorrect`);
    assert(
        clusterFields[0] === dimensions[0]
        && clusterFields[1] === dimensions[1]
        && clusterFields[2] === dimensions[2],
        `Camera cluster dimensions ${clusterFields.slice(0, 3)} != ${dimensions}`,
    );
    assert(clusterFields[3] === app.lights.capacity,
        `Camera cluster capacity ${clusterFields[3]} != ${app.lights.capacity}`);
    return {
        grid,
        byteLength: gpuData.byteLength,
        byteForByteCPUAgreement: true,
        viewport,
        depth,
        clusterFields,
    };
}

export async function runValidation(app: ProjectApp) {
    const previousSettings = { ...settings };
    const previousLightCount = app.lights.numLights;
    const previousResolution = app.resolution;
    const previousPose = {
        position: Array.from(app.camera.cameraPos) as [number, number, number],
        yaw: app.camera.yaw,
        pitch: app.camera.pitch,
    };
    const previousInputEnabled = app.camera.inputEnabled;
    const previousKeys = { ...app.camera.keys };
    const errorsBefore = app.errors.length;
    const rows: ValidationRow[] = [];
    let originalLightBuffer: ArrayBuffer | undefined;

    const test = async (name: string, work: () => Promise<unknown>): Promise<void> => {
        app.setStatus(`Validating: ${name}`);
        try {
            rows.push({ name, passed: true, metrics: await work() });
        } catch (error) {
            rows.push({
                name,
                passed: false,
                metrics: error instanceof ValidationFailure ? error.evidence : undefined,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
        }
    };

    let naiveReference: Float32Array | undefined;
    let forwardDirect: Float32Array | undefined;
    let forwardPrepass: Float32Array | undefined;
    let arcadeForwardDirect: Float32Array | undefined;
    let bloomDisabledSnapshot: RenderSnapshot | undefined;
    const deferredImages = new Map<string, Float32Array>();

    app.pause();
    try {
        try {
            await profiler.drain();
        } catch (error) {
            rows.push({
                name: 'Drain prior profiling work',
                passed: false,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
        }
        try {
            originalLightBuffer = await readBuffer(app.lights.lightSetStorageBuffer);
        } catch (error) {
            rows.push({
                name: 'Snapshot original GPU light state',
                passed: false,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
        }

        await test('Naive Atrium reference is finite and nonblack', async () => {
            configureDeterministic(app);
            naiveReference = await renderHDRFrame(app);
            const evidence = comparisonEvidence(naiveReference, naiveReference, strictThresholds, strictGate);
            assert(evidence.gate.passed, evidence.gate.failures.join('; '), evidence);
            assert(evidence.metrics.coveredPixels > evidence.metrics.totalPixels * 0.01,
                'Reference has insufficient nonblack coverage', evidence);
            return evidence;
        });

        await test('Naive direct versus render bundles', async () => {
            const reference = requireImage(naiveReference, 'Naive direct reference');
            configureDeterministic(app, { mode: 'naive', bundles: true });
            return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
        });

        await test('Naive versus ordinary Forward+', async () => {
            const reference = requireImage(naiveReference, 'Naive reference');
            configureDeterministic(app, { mode: 'forward+', depthMode: 'off', bundles: false });
            forwardDirect = await renderHDRFrame(app);
            return requireComparison(reference, forwardDirect, strictThresholds, strictGate);
        });

        await test('Forward+ direct versus render bundles', async () => {
            const reference = requireImage(forwardDirect, 'Forward+ direct image');
            configureDeterministic(app, { mode: 'forward+', depthMode: 'off', bundles: true });
            return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
        });

        await test('Naive versus Forward+ depth prepass with documented coplanar ties', async () => {
            const reference = requireImage(naiveReference, 'Naive reference');
            configureDeterministic(app, { mode: 'forward+', depthMode: 'prepass', bundles: true });
            forwardPrepass = await renderHDRFrame(app);
            return requireComparison(reference, forwardPrepass, strictThresholds, coplanarTieGate);
        });

        await test('Forward+ prepass versus prepass plus active-cluster culling', async () => {
            const reference = requireImage(forwardPrepass, 'Forward+ prepass image');
            configureDeterministic(app, { mode: 'forward+', depthMode: 'culling', bundles: true });
            return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
        });

        const deferredVariants = [
            { key: 'mrt-fullscreen', label: 'Deferred MRT fullscreen', deferredCompute: false, compactGBuffer: false },
            { key: 'mrt-compute', label: 'Deferred MRT compute', deferredCompute: true, compactGBuffer: false },
            { key: 'compact-fullscreen', label: 'Deferred compact fullscreen', deferredCompute: false, compactGBuffer: true },
            { key: 'compact-compute', label: 'Deferred compact compute', deferredCompute: true, compactGBuffer: true },
        ] as const;
        for (const variant of deferredVariants) {
            await test(`${variant.label} versus naive with declared G-buffer encoding budget`, async () => {
                const reference = requireImage(naiveReference, 'Naive reference');
                configureDeterministic(app, {
                    mode: 'clustered deferred',
                    deferredCompute: variant.deferredCompute,
                    compactGBuffer: variant.compactGBuffer,
                    bundles: false,
                });
                const image = await renderHDRFrame(app);
                deferredImages.set(variant.key, image);
                return requireComparison(reference, image, encodingThresholds, encodingGate);
            });
        }

        await test('Deferred MRT fullscreen versus compute lighting', async () => requireComparison(
            requireImage(deferredImages.get('mrt-fullscreen'), 'Deferred MRT fullscreen image'),
            requireImage(deferredImages.get('mrt-compute'), 'Deferred MRT compute image'),
            strictThresholds,
            strictGate,
        ));
        await test('Deferred compact fullscreen versus compute lighting', async () => requireComparison(
            requireImage(deferredImages.get('compact-fullscreen'), 'Deferred compact fullscreen image'),
            requireImage(deferredImages.get('compact-compute'), 'Deferred compact compute image'),
            strictThresholds,
            strictGate,
        ));

        await test('Deferred MRT direct versus render bundles', async () => {
            const reference = requireImage(deferredImages.get('mrt-fullscreen'), 'Deferred MRT direct image');
            configureDeterministic(app, {
                mode: 'clustered deferred', deferredCompute: false, compactGBuffer: false, bundles: true,
            });
            return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
        });
        await test('Deferred compact direct versus render bundles', async () => {
            const reference = requireImage(deferredImages.get('compact-compute'), 'Deferred compact direct image');
            configureDeterministic(app, {
                mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true, bundles: true,
            });
            return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
        });

        await test('Arcade camera transform changes the Forward+ image', async () => {
            const original = requireImage(forwardDirect, 'Atrium Forward+ image');
            configureDeterministic(app, {
                mode: 'forward+', depthMode: 'off', bundles: false, cameraPreset: 'Arcade',
            });
            arcadeForwardDirect = await renderHDRFrame(app);
            const metrics = compareHDR(original, arcadeForwardDirect, cameraChangeThresholds);
            const meaningfullyChangedRawPixels = metrics.totalPixels - metrics.rawPixelsWithinToleranceAll;
            const meaningfullyChangedDisplayedPixels = metrics.totalPixels - metrics.displayedPixelsWithinTolerance;
            const evidence = { metrics, meaningfullyChangedRawPixels, meaningfullyChangedDisplayedPixels };
            assert(metrics.finite, 'Moved-camera image contains non-finite values', evidence);
            assert(meaningfullyChangedRawPixels > 0 && meaningfullyChangedDisplayedPixels > 0,
                'Arcade and Atrium images are not measurably different', evidence);
            return evidence;
        });

        await test('Arcade Forward+ direct versus render bundles', async () => {
            const reference = requireImage(arcadeForwardDirect, 'Arcade Forward+ direct image');
            configureDeterministic(app, {
                mode: 'forward+', depthMode: 'off', bundles: true, cameraPreset: 'Arcade',
            });
            return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
        });

        const optimizedCases: ReadonlyArray<{
            readonly name: string;
            readonly reference: () => Float32Array | undefined;
            readonly configuration: Configuration;
        }> = [
            { name: 'Naive optimized light math parity', reference: () => naiveReference, configuration: { mode: 'naive', bundles: false } },
            { name: 'Forward+ optimized light math parity', reference: () => forwardDirect, configuration: { mode: 'forward+', depthMode: 'off', bundles: false } },
            { name: 'Deferred MRT optimized light math parity', reference: () => deferredImages.get('mrt-compute'), configuration: { mode: 'clustered deferred', deferredCompute: true, compactGBuffer: false, bundles: false } },
            { name: 'Deferred compact optimized light math parity', reference: () => deferredImages.get('compact-compute'), configuration: { mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true, bundles: false } },
        ];
        for (const optimizedCase of optimizedCases) {
            await test(optimizedCase.name, async () => {
                const reference = requireImage(optimizedCase.reference(), `${optimizedCase.name} unoptimized image`);
                configureDeterministic(app, { ...optimizedCase.configuration, optimizedLightMath: true });
                return requireComparison(reference, await renderHDRFrame(app), strictThresholds, strictGate);
            });
        }

        await test('Camera 304-byte GPU ABI updates across cluster grids', async () => ({
            primary: await validateCameraUniforms(app, '16x9x24'),
            alternate: await validateCameraUniforms(app, '8x4x16'),
        }));

        const resizeCases: ReadonlyArray<{
            readonly name: string;
            readonly configuration: Configuration;
        }> = [
            { name: 'Naive renderer resize lifecycle', configuration: { mode: 'naive' } },
            { name: 'Forward+ renderer resize lifecycle', configuration: { mode: 'forward+', depthMode: 'culling' } },
            {
                name: 'Compact deferred compute resize lifecycle',
                configuration: {
                    mode: 'clustered deferred',
                    deferredCompute: true,
                    compactGBuffer: true,
                },
            },
        ];
        for (const resizeCase of resizeCases) {
            await test(resizeCase.name, async () => {
                configureDeterministic(app, resizeCase.configuration);
                const frames: object[] = [];
                for (const [width, height] of [[1, 1], [1001, 563], [480, 270]] as const) {
                    app.renderer.resize(width, height);
                    const hdr = await renderHDRFrame(app);
                    assert(canvas.width === width && canvas.height === height,
                        `Canvas is ${canvas.width}x${canvas.height}, expected ${width}x${height}`);
                    assert(
                        app.renderer.outputTexture.width === width
                        && app.renderer.outputTexture.height === height,
                        `HDR target is ${app.renderer.outputTexture.width}x${app.renderer.outputTexture.height}, expected ${width}x${height}`,
                    );
                    assert(hdr.length === width * height * 4,
                        `HDR readback length ${hdr.length} != ${width * height * 4}`);
                    assert(hdr.every(value => Number.isFinite(value)),
                        `Non-finite RGBA value after ${width}x${height} resize`);
                    frames.push({ width, height, rgbaValues: hdr.length });
                }
                return { configuredOnce: true, frames };
            });
        }

        // Exact presentation comparisons use fixed-order naive lighting so
        // parallel cluster insertion cannot perturb the HDR rounding.
        await test('Bloom disabled deterministic baseline', async () => {
            configureDeterministic(app, {
                mode: 'naive',
                depthMode: 'off',
                bloom: false,
                bloomThreshold: 0,
                bloomStrength: 0.5,
            });
            bloomDisabledSnapshot = await renderSnapshot(app, false);
            const stats = analyzeRGB(bloomDisabledSnapshot.hdr);
            assert(stats.finite && stats.nonzeroPixels > 0, 'Bloom baseline HDR is invalid or black', stats);
            return { hdr: stats, presentedPixels: bloomDisabledSnapshot.presented.length / 4 };
        });

        await test('Bloom positive effect changes presentation and populates Gaussian texture', async () => {
            const disabled = bloomDisabledSnapshot;
            assert(disabled !== undefined, 'Bloom-disabled snapshot was not captured');
            configureDeterministic(app, {
                mode: 'naive',
                depthMode: 'off',
                bloom: true,
                bloomThreshold: 0,
                bloomStrength: 0.5,
            });
            const enabled = await renderSnapshot(app, true);
            const bloom = enabled.bloom;
            assert(bloom !== undefined, 'Bloom texture was not captured');
            const bloomStats = analyzeRGB(bloom);
            const presented = comparePresented(disabled.presented, enabled.presented);
            const hdrParity = comparisonEvidence(disabled.hdr, enabled.hdr, strictThresholds, strictGate);
            const evidence = { bloom: bloomStats, presented, hdrParity };
            assert(bloomStats.finite, 'Bloom texture contains non-finite RGBA values', evidence);
            assert(bloomStats.nonzeroPixels > 0 && bloomStats.maximum > 0,
                'Positive bloom stimulus produced no positive bloom RGB', evidence);
            assert(presented.changedPixels > 0,
                'Positive bloom stimulus did not change presented RGB bytes', evidence);
            assert(hdrParity.gate.passed,
                `Bloom changed pre-postprocessing HDR: ${hdrParity.gate.failures.join('; ')}`, evidence);
            return evidence;
        });

        await test('Bloom strength zero exactly matches disabled presentation', async () => {
            const disabled = bloomDisabledSnapshot;
            assert(disabled !== undefined, 'Bloom-disabled snapshot was not captured');
            configureDeterministic(app, {
                mode: 'naive',
                depthMode: 'off',
                bloom: true,
                bloomThreshold: 0,
                bloomStrength: 0,
            });
            const zeroStrength = await renderSnapshot(app, true);
            const presented = comparePresented(disabled.presented, zeroStrength.presented);
            assert(arraysEqual(disabled.presented, zeroStrength.presented),
                'Zero-strength bloom presentation differs from disabled bloom', presented);
            return { presented, bloom: analyzeRGB(zeroStrength.bloom!) };
        });

        await test('Huge bloom threshold produces finite black bloom and unchanged presentation', async () => {
            const disabled = bloomDisabledSnapshot;
            assert(disabled !== undefined, 'Bloom-disabled snapshot was not captured');
            configureDeterministic(app, {
                mode: 'naive',
                depthMode: 'off',
                bloom: true,
                bloomThreshold: 1e9,
                bloomStrength: 0.5,
            });
            const highThreshold = await renderSnapshot(app, true);
            const bloomStats = analyzeRGB(highThreshold.bloom!);
            const presented = comparePresented(disabled.presented, highThreshold.presented);
            const evidence = { bloom: bloomStats, presented };
            assert(bloomStats.finite && bloomStats.nonzeroPixels === 0,
                'Huge threshold did not produce a finite black bloom texture', evidence);
            assert(arraysEqual(disabled.presented, highThreshold.presented),
                'Huge-threshold bloom changed the presented canvas', evidence);
            return evidence;
        });

        await test('Zero lights remain black through HDR, bloom, and presentation', async () => {
            configureDeterministic(app, {
                mode: 'forward+',
                depthMode: 'off',
                lightCount: 0,
                bloom: true,
                bloomThreshold: 0,
                bloomStrength: 0.5,
            });
            const snapshot = await renderSnapshot(app, true);
            const hdrStats = analyzeRGB(snapshot.hdr);
            const bloomStats = analyzeRGB(snapshot.bloom!);
            const presentedStats = analyzeRGB(snapshot.presented);
            const evidence = { hdr: hdrStats, bloom: bloomStats, presented: presentedStats };
            assert(hdrStats.finite && hdrStats.nonzeroPixels === 0,
                'Zero-light HDR contains nonzero or non-finite RGB', evidence);
            assert(bloomStats.finite && bloomStats.nonzeroPixels === 0,
                'Zero-light bloom contains nonzero or non-finite RGB', evidence);
            assert(presentedStats.finite && presentedStats.nonzeroPixels === 0,
                'Zero-light presented canvas contains nonzero RGB', evidence);
            return evidence;
        });

        await test('Visible depth is fully covered by the active-cluster mask', async () => {
            configureDeterministic(app, {
                mode: 'forward+',
                depthMode: 'culling',
                lightCount: 5000,
            });
            app.render();
            const forward = app.renderer as ForwardPlusRenderer;
            assert(forward.activeMaskBuffer !== undefined, 'Forward+ active mask buffer is unavailable');
            const [flagData, recordData, depthBytes] = await Promise.all([
                readBuffer(forward.activeMaskBuffer),
                readBuffer(app.lights.clustersBuffer),
                readTexture(forward.depthTexture, 4, 'depth-only'),
            ]);
            const flags = new Uint32Array(flagData);
            const records = new Uint32Array(recordData);
            const depths = new Float32Array(
                depthBytes.buffer,
                depthBytes.byteOffset,
                depthBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
            );
            const dimensions = app.lights.clusterDimensions;
            const stride = app.lights.capacity + 2;
            assert(flags.length === app.lights.clusterCount,
                `Active mask has ${flags.length} entries, expected ${app.lights.clusterCount}`);
            assert(records.length === app.lights.clusterCount * stride,
                `Cluster readback has ${records.length} words, expected ${app.lights.clusterCount * stride}`);
            assert(depths.length === canvas.width * canvas.height,
                `Depth readback has ${depths.length} values, expected ${canvas.width * canvas.height}`);

            let visiblePixels = 0;
            let missingPixels = 0;
            let overflowPixels = 0;
            for (let y = 0; y < canvas.height; y += 1) {
                for (let x = 0; x < canvas.width; x += 1) {
                    const depth = depths[y * canvas.width + x];
                    assert(Number.isFinite(depth), `Depth is non-finite at pixel (${x}, ${y})`);
                    if (depth >= 1) continue;
                    visiblePixels += 1;
                    const view = multiplyPoint(app.camera.invProjMat, [
                        (x + 0.5) / canvas.width * 2 - 1,
                        1 - (y + 0.5) / canvas.height * 2,
                        depth,
                        1,
                    ]);
                    const z = sliceIndex(
                        -view[2] / view[3],
                        dimensions[2],
                        Camera.nearPlane,
                        Camera.farPlane,
                    );
                    const cluster = flatten(
                        Math.min(
                            dimensions[0] - 1,
                            Math.floor((x + 0.5) * dimensions[0] / canvas.width),
                        ),
                        Math.min(
                            dimensions[1] - 1,
                            Math.floor((y + 0.5) * dimensions[1] / canvas.height),
                        ),
                        z,
                        dimensions,
                    );
                    if (flags[cluster] === 0) missingPixels += 1;
                    if (records[cluster * stride + 1] !== 0) overflowPixels += 1;
                }
            }
            for (let cluster = 0; cluster < flags.length; cluster += 1) {
                assert(flags[cluster] === 0 || flags[cluster] === 1,
                    `Active mask cluster ${cluster} has invalid flag ${flags[cluster]}`);
                if (flags[cluster] === 0) {
                    assert(
                        records[cluster * stride] === 0 && records[cluster * stride + 1] === 0,
                        `Inactive cluster ${cluster} retained count or overflow`,
                    );
                }
            }
            assert(visiblePixels > 0 && missingPixels === 0,
                `${missingPixels}/${visiblePixels} visible pixels have inactive clusters`);
            return {
                visiblePixels,
                missingPixels,
                activeClusters: flags.filter(value => value !== 0).length,
                totalClusters: flags.length,
                overflowPixelFraction: overflowPixels / visiblePixels,
                capacity: app.lights.capacity,
            };
        });

        await test('GPU clusters agree with independent CPU bounds and membership', async () => {
            configureDeterministic(app, {
                mode: 'forward+',
                depthMode: 'off',
                clusterGrid: '4x3x4',
                lightCount: 32,
            });
            app.camera.onFrame(0);
            const lightValues = new Float32Array(32 * 8);
            const viewPoints: number[][] = [];
            for (let light = 0; light < 32; light += 1) {
                const ndc = [
                    -0.8 + (light % 4) * 0.5,
                    -0.6 + (Math.floor(light / 4) % 3) * 0.5,
                    0.94 + (light % 5) * 0.009,
                    1,
                ];
                const homogeneous = multiplyPoint(app.camera.invViewProjMat, ndc);
                const world = homogeneous.map(value => value / homogeneous[3]);
                lightValues.set(
                    [world[0], world[1], world[2], 0, 0.1, 0.1, 0.1, 0],
                    light * 8,
                );
                const transformed = multiplyPoint(
                    app.camera.viewMat,
                    [world[0], world[1], world[2], 1],
                );
                viewPoints.push(transformed.slice(0, 3));
            }
            device.queue.writeBuffer(app.lights.lightSetStorageBuffer, 16, lightValues);
            const encoder = device.createCommandEncoder({
                label: 'Validation independent cluster fixture',
            });
            app.lights.invalidateBounds();
            app.lights.doLightClustering(encoder);
            device.queue.submit([encoder.finish()]);
            const [recordData, boundData] = await Promise.all([
                readBuffer(app.lights.clustersBuffer),
                readBuffer(app.lights.boundsBuffer),
            ]);
            const records = new Uint32Array(recordData);
            const gpuBounds = new Float32Array(boundData);
            const stride = app.lights.capacity + 2;
            assert(records.length === app.lights.clusterCount * stride,
                `Fixture cluster readback has ${records.length} words, expected ${app.lights.clusterCount * stride}`);
            assert(gpuBounds.length === app.lights.clusterCount * 8,
                `Fixture bounds readback has ${gpuBounds.length} floats, expected ${app.lights.clusterCount * 8}`);
            let membershipChecks = 0;
            for (let cluster = 0; cluster < app.lights.clusterCount; cluster += 1) {
                const gpu = [
                    gpuBounds[cluster * 8],
                    gpuBounds[cluster * 8 + 1],
                    gpuBounds[cluster * 8 + 2],
                    gpuBounds[cluster * 8 + 4],
                    gpuBounds[cluster * 8 + 5],
                    gpuBounds[cluster * 8 + 6],
                ];
                const cpu = boundsForCluster(
                    cluster,
                    app.lights.clusterDimensions,
                    app.camera.invProjMat,
                    Camera.nearPlane,
                    Camera.farPlane,
                );
                for (let axis = 0; axis < 6; axis += 1) {
                    assert(
                        Math.abs(gpu[axis] - cpu[axis])
                            <= 2e-4 * Math.max(1, Math.abs(gpu[axis])),
                        `Cluster ${cluster} bound axis ${axis} differs: GPU=${gpu[axis]}, CPU=${cpu[axis]}`,
                    );
                }
                const expected = viewPoints.flatMap((point, light) => (
                    sphereIntersects(point, 2, cpu) ? [light] : []
                ));
                const offset = cluster * stride;
                assert(records[offset] <= app.lights.capacity,
                    `Cluster ${cluster} count ${records[offset]} exceeds capacity ${app.lights.capacity}`);
                assert(records[offset + 1] === 0,
                    `32-light fixture unexpectedly overflowed cluster ${cluster}`);
                const actual = Array.from(records.slice(offset + 2, offset + 2 + records[offset]))
                    .sort((left, right) => left - right);
                assert(
                    JSON.stringify(actual) === JSON.stringify(expected),
                    `Cluster ${cluster} membership differs: GPU=${actual}, CPU=${expected}`,
                );
                membershipChecks += expected.length;
            }
            return {
                clusters: app.lights.clusterCount,
                dimensions: app.lights.clusterDimensions,
                capacity: app.lights.capacity,
                membershipChecks,
            };
        });

        await test('Dynamic-capacity overflow, zero lights, and mask reset', async () => {
            configureDeterministic(app, {
                mode: 'forward+',
                depthMode: 'off',
                clusterGrid: '8x4x16',
                lightCount: 0,
            });
            app.camera.onFrame(0);
            const capacity = app.lights.capacity;
            assert(capacity > 0 && capacity < 5000,
                `Capacity ${capacity} cannot exercise the required 5000-light overflow fixture`);
            const location = [
                app.camera.cameraPos[0] + app.camera.cameraFront[0] * 5,
                app.camera.cameraPos[1] + app.camera.cameraFront[1] * 5,
                app.camera.cameraPos[2] + app.camera.cameraFront[2] * 5,
            ];
            const fixture = new Float32Array(5000 * 8);
            for (let light = 0; light < 5000; light += 1) {
                fixture.set([...location, 0, 0.1, 0.1, 0.1, 0], light * 8);
            }
            device.queue.writeBuffer(app.lights.lightSetStorageBuffer, 16, fixture);

            const stride = capacity + 2;
            const overflowRuns: object[] = [];
            for (const count of [capacity - 1, capacity, capacity + 1, 5000, 0]) {
                app.lights.numLights = count;
                app.lights.updateLightSetUniformNumLights();
                const encoder = device.createCommandEncoder({
                    label: `Validation clustering ${count} lights`,
                });
                app.lights.doLightClustering(encoder);
                device.queue.submit([encoder.finish()]);
                const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
                let overflowClusters = 0;
                let nonemptyClusters = 0;
                for (let cluster = 0; cluster < app.lights.clusterCount; cluster += 1) {
                    const record = cluster * stride;
                    const storedCount = records[record];
                    const overflow = records[record + 1];
                    assert(storedCount <= capacity,
                        `Run ${count}, cluster ${cluster}: count ${storedCount} exceeds capacity ${capacity}`);
                    assert(overflow === 0 || overflow === 1,
                        `Run ${count}, cluster ${cluster}: invalid overflow ${overflow}`);
                    if (storedCount !== 0) nonemptyClusters += 1;
                    if (overflow !== 0) overflowClusters += 1;
                    if (count === 0) {
                        assert(storedCount === 0 && overflow === 0,
                            `Zero-light run retained cluster ${cluster} state`);
                    }
                }
                if (count <= capacity) {
                    assert(overflowClusters === 0,
                        `${count}-light run produced ${overflowClusters} false overflow records`);
                } else {
                    assert(overflowClusters > 0,
                        `${count}-light run did not produce an overflow record`);
                }
                overflowRuns.push({ count, nonemptyClusters, overflowClusters });
            }

            const mask = device.createBuffer({
                label: 'Validation active-cluster mask reset fixture',
                size: app.lights.clusterCount * Uint32Array.BYTES_PER_ELEMENT,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            const maskRuns: object[] = [];
            try {
                app.lights.numLights = 32;
                app.lights.updateLightSetUniformNumLights();
                for (const enabled of [0, 1, 0]) {
                    device.queue.writeBuffer(
                        mask,
                        0,
                        new Uint32Array(app.lights.clusterCount).fill(enabled),
                    );
                    const encoder = device.createCommandEncoder({
                        label: `Validation active mask reset ${enabled}`,
                    });
                    app.lights.doLightClustering(encoder, mask);
                    device.queue.submit([encoder.finish()]);
                    const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
                    let nonemptyClusters = 0;
                    for (let cluster = 0; cluster < app.lights.clusterCount; cluster += 1) {
                        const offset = cluster * stride;
                        if (records[offset] !== 0) nonemptyClusters += 1;
                        if (enabled === 0) {
                            assert(records[offset] === 0 && records[offset + 1] === 0,
                                `Disabled mask retained count/overflow in cluster ${cluster}`);
                        }
                    }
                    if (enabled === 1) {
                        assert(nonemptyClusters > 0, 'Enabled mask produced no populated clusters');
                    }
                    maskRuns.push({ enabled, nonemptyClusters });
                }
            } finally {
                mask.destroy();
            }
            return { capacity, overflowRuns, maskRuns };
        });

        await test('Overflow fallback shades every light exactly once', async () => {
            const lightCount = 5000;
            configureDeterministic(app, {
                mode: 'naive', lightCount, clusterGrid: '8x4x16', optimizedLightMath: true,
            });
            const animation = app.lights.onFrame;
            const lightData = new Float32Array(lightCount * 8);
            const position = [app.camera.cameraPos[0] + 7, 0.7, app.camera.cameraPos[2]];
            for (let light = 0; light < lightCount; light++) {
                lightData.set([...position, 0, 0.1 / lightCount, 0.2 / lightCount, 0.3 / lightCount, 0], light * 8);
            }
            // Keep the controlled fixture intact while rendering both paths.
            app.lights.onFrame = () => {};
            try {
                device.queue.writeBuffer(app.lights.lightSetStorageBuffer, 16, lightData);
                const reference = await renderHDRFrame(app);
                configureDeterministic(app, {
                    mode: 'forward+', lightCount, clusterGrid: '8x4x16', optimizedLightMath: true,
                });
                const candidate = await renderHDRFrame(app);
                const evidence = requireComparison(reference, candidate, strictThresholds, strictGate);
                const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
                const stride = app.lights.capacity + 2;
                let overflowClusters = 0;
                for (let cluster = 0; cluster < app.lights.clusterCount; cluster++) {
                    if (records[cluster * stride + 1] !== 0) overflowClusters++;
                }
                assert(overflowClusters > 0, 'Shading fixture did not exercise overflow', evidence);
                return { ...evidence, lightCount, overflowClusters, position };
            } finally {
                app.lights.onFrame = animation;
            }
        });

        await test('Real GPU compact G-buffer packing helpers', async () => validatePacking());

        await test('No uncaptured GPU errors', async () => {
            await device.queue.onSubmittedWorkDone();
            const errors = app.errors.slice(errorsBefore);
            assert(errors.length === 0, errors.join('\n'), { errors });
            return { errors };
        });
    } finally {
        const restorationErrors: string[] = [];
        try {
            await profiler.drain();
        } catch (error) {
            restorationErrors.push(`profiler drain: ${String(error)}`);
        }
        try {
            app.configure({
                ...previousSettings,
                lightCount: previousLightCount,
                resolution: previousResolution,
            });
            app.pause();
        } catch (error) {
            restorationErrors.push(`settings/resolution: ${String(error)}`);
            Object.assign(settings, previousSettings);
        }
        try {
            app.camera.setPose(previousPose.position, previousPose.yaw, previousPose.pitch);
        } catch (error) {
            restorationErrors.push(`camera pose: ${String(error)}`);
        }
        try {
            app.lights.numLights = previousLightCount;
            if (originalLightBuffer !== undefined) {
                device.queue.writeBuffer(
                    app.lights.lightSetStorageBuffer,
                    0,
                    new Uint8Array(originalLightBuffer),
                );
            } else {
                device.queue.writeBuffer(
                    app.lights.lightSetStorageBuffer,
                    16,
                    app.lights.lightsArray,
                );
                app.lights.updateLightSetUniformNumLights();
            }
        } catch (error) {
            restorationErrors.push(`light state: ${String(error)}`);
        }
        try {
            app.resume();
        } catch (error) {
            restorationErrors.push(`resume: ${String(error)}`);
        }
        try {
            app.camera.inputEnabled = previousInputEnabled;
            app.camera.keys = previousKeys;
        } catch (error) {
            restorationErrors.push(`camera input state: ${String(error)}`);
        }
        if (restorationErrors.length > 0) {
            rows.push({
                name: 'Restore application state',
                passed: false,
                error: restorationErrors.join('; '),
            });
        }
    }

    const report = {
        capturedAt: new Date().toISOString(),
        passed: rows.every(row => row.passed),
        comparisonPolicy: {
            strictSamePath: {
                thresholds: strictThresholds,
                gate: strictGate,
                explanation: 'Direct/bundle, compute/fullscreen, ordinary Forward+, and optimized-math parity use raw linear HDR agreement over all pixels plus display gates.',
            },
            depthPrepassCoplanarTies: {
                thresholds: strictThresholds,
                gate: coplanarTieGate,
                explanation: 'Only naive versus equal-depth prepass shading permits rare coplanar depth ties; this policy is not used for other same-path checks.',
            },
            quantizedDeferred: {
                thresholds: encodingThresholds,
                gate: encodingGate,
                explanation: 'Deferred variants encode albedo as UNORM8, normals as float16 or octahedral SNORM16, and compact variants reconstruct position from depth. Raw covered HDR and displayed output are both gated.',
            },
        },
        capacity: app.lights.capacity,
        tests: rows,
        gpuErrors: app.errors.slice(errorsBefore),
        evidencePath: 'performance/validation.json',
    };
    await saveEvidence('performance/validation.json', JSON.stringify(report, null, 2));
    if (!report.passed) {
        throw new Error(
            `${rows.filter(row => !row.passed).length} validation checks failed; `
            + 'inspect docs/performance/validation.json',
        );
    }
    return report;
}
