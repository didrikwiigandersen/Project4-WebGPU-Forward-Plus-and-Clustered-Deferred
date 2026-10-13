import { ProjectApp, saveEvidence } from './app_api';
import { settings } from './settings';
import { canvas, device } from './renderer';
import { profiler } from './profiler';
import { readBuffer, readHDR, readTexture, canvasPixels } from './gpu_io';
import { boundsForCluster, multiplyPoint, sphereIntersects, flatten, sliceIndex } from './cluster_math';
import { ForwardPlusRenderer } from './renderers/forward_plus';

function assert(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
function compare(reference: Float32Array, candidate: Float32Array) {
    assert(reference.length === candidate.length, 'Image sizes differ');
    let error = 0, covered = 0, within = 0, hdrWithin = 0, maximum = 0, finite = true;
    for (let pixel = 0; pixel < reference.length; pixel += 4) {
        let peak = 0, occupies = false, hdr = true;
        for (let channel = 0; channel < 3; channel++) {
            const a = reference[pixel + channel], b = candidate[pixel + channel];
            finite &&= Number.isFinite(a) && Number.isFinite(b);
            const difference = Math.abs(Math.max(0, Math.min(1, a)) - Math.max(0, Math.min(1, b)));
            error += difference; peak = Math.max(peak, difference);
            occupies ||= a > .0001;
            hdr &&= Math.abs(a - b) <= 1e-4 + 1e-3 * Math.abs(a);
        }
        maximum = Math.max(maximum, peak);
        if (occupies) { covered++; if (peak <= 4 / 255) within++; if (hdr) hdrWithin++; }
    }
    return { meanAbsoluteRgb: error / (reference.length / 4 * 3), coveredPixels: covered, fractionWithin4Bytes: within / Math.max(1, covered), fractionHdrWithin: hdrWithin / Math.max(1, covered), maximum, finite };
}
export async function runValidation(app: ProjectApp) {
    const previous = { ...settings }, lightCount = app.lights.numLights, width = canvas.width, height = canvas.height;
    const pose = { position: Array.from(app.camera.cameraPos) as [number, number, number], yaw: app.camera.yaw, pitch: app.camera.pitch };
    const errorsBefore = app.errors.length;
    const rows: { name: string; passed: boolean; metrics?: unknown; error?: string }[] = [];
    const test = async (name: string, work: () => Promise<unknown>) => {
        app.setStatus(`Validating: ${name}`);
        try { rows.push({ name, passed: true, metrics: await work() }); }
        catch (error) { rows.push({ name, passed: false, error: String(error) }); }
    };
    app.pause(); await profiler.drain();
    try {
        app.configure({ mode: 'naive', lightCount: 1024, width: 480, height: 270, cameraPreset: 'Atrium', freezeLights: true, fixedTime: 1000, bloom: false, debugView: 'none', bundles: false, clusterGrid: '16x9x24' }); app.pause(); app.render();
        const reference = await readHDR(app.renderer.outputTexture);
        await test('Naive reference is finite and nonblack', async () => {
            const metrics = compare(reference, reference);
            assert(metrics.finite && metrics.coveredPixels > 480 * 270 * .01, 'Reference is nonfinite or unexpectedly black');
            return metrics;
        });
        const variants = [
            { name: 'Forward+ direct', mode: 'forward+', depthMode: 'off', bundles: false },
            { name: 'Forward+ bundles', mode: 'forward+', depthMode: 'off', bundles: true },
            { name: 'Forward+ depth prepass', mode: 'forward+', depthMode: 'prepass', bundles: true },
            { name: 'Forward+ active-cluster culling', mode: 'forward+', depthMode: 'culling', bundles: true },
            { name: 'Deferred MRT fullscreen', mode: 'clustered deferred', deferredCompute: false, compactGBuffer: false },
            { name: 'Deferred MRT compute', mode: 'clustered deferred', deferredCompute: true, compactGBuffer: false },
            { name: 'Deferred compact fullscreen', mode: 'clustered deferred', deferredCompute: false, compactGBuffer: true },
            { name: 'Deferred compact compute', mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true },
        ] as const;
        for (const variant of variants) await test(variant.name, async () => {
            const { name: _name, ...configuration } = variant;
            app.configure(configuration); app.pause(); app.render();
            const metrics = compare(reference, await readHDR(app.renderer.outputTexture));
            assert(metrics.finite, 'Nonfinite HDR pixel');
            assert(metrics.meanAbsoluteRgb <= 2 / 255 && metrics.fractionWithin4Bytes >= .99, `Image mismatch: ${JSON.stringify(metrics)}`);
            return metrics;
        });
        await test('Visible-depth coverage of active-cluster mask', async () => {
            app.configure({ mode: 'forward+', depthMode: 'culling', lightCount: 5000 }); app.pause(); app.render();
            const forward = app.renderer as ForwardPlusRenderer;
            const flags = new Uint32Array(await readBuffer(forward.activeMaskBuffer!));
            const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
            const bytes = await readTexture(forward.depthTexture, 4, 'depth-only');
            const depths = new Float32Array(bytes.buffer);
            const dimensions = app.lights.clusterDimensions;
            const inverse = app.camera.invProjMat;
            let visible = 0, missing = 0, shadedOverflow = 0;
            for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
                const depth = depths[y * canvas.width + x]; if (depth >= 1) continue;
                visible++;
                const view = multiplyPoint(inverse, [(x + .5) / canvas.width * 2 - 1, 1 - (y + .5) / canvas.height * 2, depth, 1]);
                const z = sliceIndex(-view[2] / view[3], dimensions[2], .1, 1000);
                const index = flatten(Math.min(dimensions[0] - 1, Math.floor((x + .5) * dimensions[0] / canvas.width)), Math.min(dimensions[1] - 1, Math.floor((y + .5) * dimensions[1] / canvas.height)), z, dimensions);
                if (!flags[index]) missing++;
                if (records[index * 258 + 1]) shadedOverflow++;
            }
            for (let i = 0; i < flags.length; i++) if (!flags[i]) assert(records[i * 258] === 0 && records[i * 258 + 1] === 0, 'Inactive cluster has stale count/overflow');
            assert(visible > 0 && missing === 0, `${missing}/${visible} visible pixels have inactive clusters`);
            return { visible, missing, activeClusters: flags.filter(v => v !== 0).length, totalClusters: flags.length, overflowPixelFraction: shadedOverflow / visible };
        });
        await test('Odd-sized compact compute and bloom', async () => {
            app.configure({ mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true, bloom: true, width: 1001, height: 563 }); app.pause(); app.render();
            const hdr = await readHDR(app.renderer.outputTexture);
            assert(hdr.every(Number.isFinite), 'Nonfinite pixel at odd dimensions');
            assert(canvas.width === 1001 && canvas.height === 563, 'Explicit resolution was not retained');
            return { width: canvas.width, height: canvas.height };
        });
        await test('Zero-light scene stays black with bloom', async () => {
            app.configure({ lightCount: 0, width: 480, height: 270, bloom: true }); app.pause(); app.render();
            const hdr = await readHDR(app.renderer.outputTexture);
            assert(hdr.every((v, i) => i % 4 === 3 || v === 0), 'Zero-light shading is not black');
            const pixels = await canvasPixels();
            assert(pixels.every((v, i) => i % 4 === 3 || v === 0), 'Bloom introduced light into black output');
            return { pixels: pixels.length / 4 };
        });
        await test('GPU clusters agree with independent CPU bounds and intersections', async () => {
            app.configure({ mode: 'forward+', depthMode: 'off', clusterGrid: '4x3x4', width: 480, height: 270, lightCount: 32, bloom: false }); app.pause(); app.camera.onFrame(0);
            const values = new Float32Array(32 * 8);
            const inverseView = app.camera.invViewProjMat;
            const viewPoints: number[][] = [];
            for (let i = 0; i < 32; i++) {
                const ndc = [-.8 + (i % 4) * .5, -.6 + (Math.floor(i / 4) % 3) * .5, .94 + (i % 5) * .009, 1];
                const world = multiplyPoint(inverseView, ndc).map((v, _, a) => v / a[3]);
                values.set([world[0], world[1], world[2], 0, .1, .1, .1, 0], i * 8);
                const transformed = multiplyPoint(app.camera.viewMat, [values[i * 8], values[i * 8 + 1], values[i * 8 + 2], 1]);
                viewPoints.push(transformed.slice(0, 3));
            }
            device.queue.writeBuffer(app.lights.lightSetStorageBuffer, 16, values);
            const encoder = device.createCommandEncoder(); app.lights.invalidateBounds(); app.lights.doLightClustering(encoder); device.queue.submit([encoder.finish()]);
            const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
            const bounds = new Float32Array(await readBuffer(app.lights.boundsBuffer));
            let membershipChecks = 0;
            for (let cluster = 0; cluster < app.lights.clusterCount; cluster++) {
                const gpu = [bounds[cluster * 8], bounds[cluster * 8 + 1], bounds[cluster * 8 + 2], bounds[cluster * 8 + 4], bounds[cluster * 8 + 5], bounds[cluster * 8 + 6]];
                const cpu = boundsForCluster(cluster, app.lights.clusterDimensions, app.camera.invProjMat, .1, 1000);
                assert(gpu.every((v, axis) => Math.abs(v - cpu[axis]) <= 2e-4 * Math.max(1, Math.abs(v))), 'CPU/GPU cluster bounds differ');
                const expected = viewPoints.flatMap((point, i) => sphereIntersects(point, 2, gpu) ? [i] : []);
                const offset = cluster * 258;
                const actual = Array.from(records.slice(offset + 2, offset + 2 + records[offset])).sort((a, b) => a - b);
                assert(JSON.stringify(actual) === JSON.stringify(expected), `Cluster ${cluster} membership mismatch`);
                membershipChecks += expected.length;
            }
            return { clusters: app.lights.clusterCount, membershipChecks };
        });
        await test('GPU overflow, zero lights, and mask reset', async () => {
            const capacity = app.lights.capacity;
            const location = [app.camera.cameraPos[0] + app.camera.cameraFront[0] * 5, app.camera.cameraPos[1] + app.camera.cameraFront[1] * 5, app.camera.cameraPos[2] + app.camera.cameraFront[2] * 5];
            let observedOverflow = 0;
            for (const count of [capacity - 1, capacity, capacity + 1, 5000, 0]) {
                app.lights.numLights = count; app.lights.updateLightSetUniformNumLights();
                const data = new Float32Array(count * 8);
                for (let i = 0; i < count; i++) data.set([...location, 0, .1, .1, .1, 0], i * 8);
                if (data.length) device.queue.writeBuffer(app.lights.lightSetStorageBuffer, 16, data);
                const encoder = device.createCommandEncoder(); app.lights.doLightClustering(encoder); device.queue.submit([encoder.finish()]);
                const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
                for (let i = 0; i < app.lights.clusterCount; i++) {
                    assert(records[i * 258] <= capacity, 'Count exceeds capacity');
                    if (count === 0) assert(records[i * 258] === 0 && records[i * 258 + 1] === 0, 'Zero lights retained stale lists');
                    if (records[i * 258 + 1]) { assert(count > capacity, 'False overflow'); observedOverflow++; }
                }
            }
            assert(observedOverflow > 0, 'Overflow stress did not overflow any cluster');
            const mask = device.createBuffer({ size: app.lights.clusterCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            app.lights.numLights = 32; app.lights.updateLightSetUniformNumLights();
            for (const enabled of [0, 1, 0]) {
                device.queue.writeBuffer(mask, 0, new Uint32Array(app.lights.clusterCount).fill(enabled));
                const encoder = device.createCommandEncoder(); app.lights.doLightClustering(encoder, mask); device.queue.submit([encoder.finish()]);
                const records = new Uint32Array(await readBuffer(app.lights.clustersBuffer));
                if (!enabled) assert(records.every((v, i) => i % 258 > 1 || v === 0), 'Inactive mask retained live counts');
            }
            mask.destroy();
            return { observedOverflow, capacity };
        });
        await test('No uncaptured GPU errors', async () => {
            await device.queue.onSubmittedWorkDone();
            assert(app.errors.length === errorsBefore, app.errors.slice(errorsBefore).join('\n'));
            return { errors: app.errors.slice(errorsBefore) };
        });
    } finally {
        device.queue.writeBuffer(app.lights.lightSetStorageBuffer, 16, app.lights.lightsArray);
        await profiler.drain(); app.configure({ ...previous, lightCount, width, height }); app.camera.setPose(pose.position, pose.yaw, pose.pitch); app.resume();
    }
    const report = { capturedAt: new Date().toISOString(), passed: rows.every(row => row.passed), tests: rows, gpuErrors: app.errors.slice(errorsBefore) };
    await saveEvidence('performance/validation.json', JSON.stringify(report, null, 2));
    if (!report.passed) throw new Error(`${rows.filter(row => !row.passed).length} validation checks failed; inspect docs/performance/validation.json`);
    return report;
}
