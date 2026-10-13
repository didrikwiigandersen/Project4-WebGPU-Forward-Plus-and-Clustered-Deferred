import { ProjectApp, Configuration, cameraPresets, saveEvidence } from './app_api';
import { settings } from './settings';
import { profiler, FrameMeasurement } from './profiler';
import { canvas, adapterInfo } from './renderer';
import { collectDiagnostics } from './diagnostics';
type BenchmarkCase = { id: string; family: string; configuration: Configuration };
function cases(scope: 'full' | 'quick' | 'capacity'): BenchmarkCase[] {
    const result: BenchmarkCase[] = [];
    const seen = new Set<string>();
    const add = (family: string, configuration: Configuration) => {
        const effective: Configuration = { mode: 'forward+', lightCount: 1024, width: 1280, height: 720, cameraPreset: 'Atrium', clusterGrid: '16x9x24', bundles: false, depthMode: 'off', deferredCompute: false, compactGBuffer: false, optimizedLightMath: true, bloom: false, bloomThreshold: 1, bloomStrength: 0.2, debugView: 'none', freezeLights: true, fixedTime: 1000, ...configuration };
        const key = JSON.stringify(effective);
        if (!seen.has(key)) { seen.add(key); result.push({ id: `${family}-${result.length}`, family, configuration: effective }); }
    };
    if (scope === 'capacity') {
        for (const clusterGrid of ['8x4x16', '16x9x24', '32x18x24']) {
            for (const optimizedLightMath of [false, true]) for (const depthMode of ['off', 'culling'] as const) add('capacity', { clusterGrid, depthMode, optimizedLightMath, mode: 'forward+', bundles: true, lightCount: 5000 });
        }
        return result;
    }
    const sizes = scope === 'full' ? [[1280, 720], [1920, 1080]] : [[1280, 720]];
    const counts = scope === 'full' ? [128, 512, 1024, 2048, 5000] : [128, 5000];
    const cameras = scope === 'full' ? ['Atrium', 'Arcade'] : ['Atrium'];
    for (const [width, height] of sizes) for (const cameraPreset of cameras) for (const lightCount of counts) {
        for (const mode of ['naive', 'forward+', 'clustered deferred']) add('renderers', { mode, width, height, cameraPreset, lightCount });
    }
    if (scope === 'full') for (const clusterGrid of ['8x4x16', '16x9x24', '32x18x24']) for (const lightCount of counts) {
        for (const mode of ['forward+', 'clustered deferred']) add('clusters', { mode, width: 1920, height: 1080, lightCount, clusterGrid });
    }
    for (const [width, height] of sizes) for (const cameraPreset of cameras) for (const lightCount of [128, 5000]) {
        const base = { width, height, cameraPreset, lightCount };
        add('compute', { ...base, mode: 'clustered deferred', deferredCompute: true });
        add('compact', { ...base, mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true });
        for (const mode of ['naive', 'forward+', 'clustered deferred']) add('bundles', { ...base, mode, bundles: true });
        add('prepass', { ...base, depthMode: 'prepass' });
        add('culling', { ...base, depthMode: 'culling' });
        add('bloom', { ...base, mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true, bloom: true });
        add('combined', { ...base, mode: 'clustered deferred', bundles: true, deferredCompute: true, compactGBuffer: true, bloom: true });
        add('combined', { ...base, bundles: true, depthMode: 'culling', bloom: true });
        add('light-math', { ...base, mode: 'forward+', optimizedLightMath: false });
        add('light-math', { ...base, mode: 'clustered deferred', deferredCompute: true, compactGBuffer: true, optimizedLightMath: false });
    }
    return result;
}
function assertConfiguration(app: ProjectApp, expected: Configuration): void {
    for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
        if (expected[key] !== undefined && settings[key] !== expected[key]) throw new Error(`Benchmark setting changed: ${key}`);
    }
    if (app.lights.numLights !== expected.lightCount || canvas.width !== expected.width || canvas.height !== expected.height) throw new Error('Benchmark light count or drawing buffer changed');
    const pose = expected.cameraPreset ? cameraPresets[expected.cameraPreset] : undefined;
    if (pose && (app.camera.yaw !== pose.yaw || app.camera.pitch !== pose.pitch || pose.position.some((value, axis) => Math.abs(value - app.camera.cameraPos[axis]) > 1e-6))) throw new Error('Benchmark camera pose changed');
}
function timestampQuantum(samples: FrameMeasurement[]): number | null {
    let quantum = 0n;
    const gcd = (a: bigint, b: bigint): bigint => { while (b) { const remainder = a % b; a = b; b = remainder; } return a; };
    let origin: bigint | undefined;
    for (const sample of samples) for (const interval of Object.values(sample.intervals ?? {})) {
        for (const value of [interval.startNs, interval.endNs]) {
            const tick = BigInt(value);
            origin ??= tick;
            quantum = gcd(quantum, tick > origin ? tick - origin : origin - tick);
        }
    }
    return quantum ? Number(quantum) : null;
}
function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}
export async function runBenchmark(app: ProjectApp, scope: 'full' | 'quick' | 'capacity') {
    if (!profiler.supported) throw new Error('This GPU does not expose timestamp-query; GPU benchmark is unavailable.');
    const previous = { ...settings }, count = app.lights.numLights, previousResolution = app.resolution, previousCameraPreset = app.cameraPreset;
    const pose = { position: Array.from(app.camera.cameraPos) as [number, number, number], yaw: app.camera.yaw, pitch: app.camera.pitch };
    const raw: { caseId: string; repeat: number; sample: FrameMeasurement }[] = [];
    const results: Record<string, unknown>[] = [];
    const plan = cases(scope);
    const evidenceName = scope === 'capacity' ? `capacity-${app.lights.capacity}` : `benchmark-${scope}`;
    app.pause(); await profiler.drain();
    try {
        for (let repeat = 0; repeat < 3; repeat++) {
            const order = repeat % 2 ? [...plan].reverse() : [...plan];
            for (let index = 0; index < order.length; index++) {
                const item = order[index];
                app.setStatus(`Benchmark ${repeat + 1}/3, case ${index + 1}/${order.length}: ${item.family}, ${item.configuration.mode}, ${item.configuration.lightCount} lights`);
                app.configure(item.configuration); app.pause();
                assertConfiguration(app, item.configuration);
                for (let i = 0; i < 120; i++) { await profiler.waitForCapacity(); app.render(); }
                await profiler.drain(); profiler.clear();
                let submitted = 0;
                while (profiler.samples.length < 300) {
                    const remaining = 300 - profiler.samples.length;
                    for (let i = 0; i < Math.min(remaining, 6); i++) {
                        await profiler.waitForCapacity(); app.render(); submitted++;
                    }
                    await profiler.drain();
                    if (submitted > 1200) throw new Error('Too many rejected timestamp samples');
                }
                const samples = profiler.samples.slice(0, 300);
                assertConfiguration(app, item.configuration);
                const gpu = samples.map(s => s.renderMs!).filter(Number.isFinite);
                const cpu = samples.map(s => s.cpuMs);
                const passes: Record<string, number> = {};
                for (const label of Object.keys(samples[0].passes)) passes[label] = percentile(samples.map(s => s.passes[label]).filter(Number.isFinite), .5);
                raw.push(...samples.map(sample => ({ caseId: item.id, repeat, sample })));
                const diagnostics = await collectDiagnostics(app);
                results.push({ ...item, repeat, diagnostics, drawingBuffer: [canvas.width, canvas.height], medianRenderMs: percentile(gpu, .5), p95RenderMs: percentile(gpu, .95), medianCpuMs: percentile(cpu, .5), p95CpuMs: percentile(cpu, .95), medianPasses: passes, rejected: profiler.rejectedSamples });
                await saveEvidence(`performance/${evidenceName}-part-${repeat}-${item.id}.json`, JSON.stringify({ caseId: item.id, repeat, configuration: item.configuration, samples }), 'application/json', false);
                await saveEvidence(`performance/${evidenceName}-checkpoint.json`, JSON.stringify({ protocol: { warmup: 120, validSamples: 300, repeats: 3 }, results }, null, 2), 'application/json', false);
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                if (app.errors.length) throw new Error(app.errors[app.errors.length - 1]);
            }
        }
        const report = { capturedAt: new Date().toISOString(), scope, capacity: app.lights.capacity, userAgent: navigator.userAgent, adapterInfo: { vendor: adapterInfo?.vendor, architecture: adapterInfo?.architecture, device: adapterInfo?.device, description: adapterInfo?.description }, timestampQuantumNs: timestampQuantum(raw.map(record => record.sample)), timestampPrecision: 'The numeric quantum is the GCD of observed timestamp tick differences, an empirical resolution bound. Native Metal render-pass spans overlap; use paired total render spans for cost comparisons.', protocol: { warmup: 120, validSamples: 300, repeats: 3, fixedTime: 1000, seed: '0x6d2b79f5', renderSpan: 'First render pass through presentation; light movement excluded.', frameSpan: 'Light movement through presentation.', cpu: 'Draw encoding and submission; excludes light movement and readback.' }, cases: plan, results, raw };
        await saveEvidence(`performance/${evidenceName}.json`, JSON.stringify(report));
        const columns = ['caseId', 'repeat', 'frame', 'renderMs', 'gpuMs', 'cpuMs'];
        const csv = [columns.join(','), ...raw.map(r => [r.caseId, r.repeat, r.sample.frame, r.sample.renderMs, r.sample.gpuMs, r.sample.cpuMs].join(','))].join('\n');
        await saveEvidence(`performance/${evidenceName}.csv`, csv, 'text/csv');
        return { scope, cases: plan.length, samples: raw.length, path: `docs/performance/${evidenceName}.json` };
    } finally {
        await profiler.drain(); app.configure({ ...previous, lightCount: count, resolution: previousResolution, cameraPreset: previousCameraPreset });
        app.camera.setPose(pose.position, pose.yaw, pose.pitch); app.resume();
    }
}
