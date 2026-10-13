import Stats from 'stats.js';
import { GUI } from 'dat.gui';
import { initWebGPU, Renderer, canvas, device, gpuErrors, adapterInfo } from './renderer';
import { NaiveRenderer } from './renderers/naive';
import { ForwardPlusRenderer } from './renderers/forward_plus';
import { ClusteredDeferredRenderer } from './renderers/clustered_deferred';
import { setupLoaders, Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { Stage } from './stage/stage';
import { settings, debugViews } from './settings';
import { profiler } from './profiler';
import { ProjectApp, Configuration, cameraPresets, saveEvidence } from './app_api';
import { runValidation } from './validation';
import { runBenchmark } from './benchmark';
import { captureDemo, captureScreenshot } from './capture';
import { readBuffer } from './gpu_io';

function status(message: string) { document.getElementById('status')!.textContent = message; }
async function start() {
    status('Initializing WebGPU…');
    await initWebGPU();
    setupLoaders();
    status('Loading the Sponza atrium…');
    const scene = new Scene();
    await scene.loadGltf('./scenes/sponza/Sponza.gltf');
    const camera = new Camera();
    const lights = new Lights(camera);
    const stage = new Stage(scene, lights, camera, new Stats());
    let renderer: Renderer;
    let manual = false;
    let resolution = 'window';
    const controls = { resolution, camera: 'Atrium' };
    const gui = new GUI({ autoPlace: false, width: 260 });
    document.getElementById('controls')!.appendChild(gui.domElement);
    function applySize() {
        if (resolution === 'window') renderer.resize();
        else {
            const [width, height] = resolution.split('x').map(Number);
            renderer.resize(width, height);
        }
        document.getElementById('resolutionValue')!.textContent = `${canvas.width} × ${canvas.height}`;
    }
    function recreate() {
        renderer?.dispose();
        lights.ensureClusterResources();
        if (settings.mode === 'naive') renderer = new NaiveRenderer(stage);
        else if (settings.mode === 'forward+') renderer = new ForwardPlusRenderer(stage);
        else renderer = new ClusteredDeferredRenderer(stage);
        applySize();
        if (manual) renderer.stop();
        document.getElementById('modeValue')!.textContent = settings.mode;
        document.getElementById('gbufferValue')!.textContent = settings.mode === 'clustered deferred' ? (settings.compactGBuffer ? '12 B/pixel' : '32 B/pixel') : 'Not used';
        updateApplicability();
    }
    const app: ProjectApp = {
        get renderer() { return renderer; }, get resolution() { return resolution; }, camera, lights,
        get errors() { return gpuErrors; },
        configure(configuration: Configuration) {
            const { lightCount, width, height, resolution: requestedResolution, cameraPreset, ...patch } = configuration;
            Object.assign(settings, patch);
            if (lightCount !== undefined) {
                lights.numLights = Math.max(0, Math.min(Lights.maxNumLights, lightCount));
                lights.updateLightSetUniformNumLights();
            }
            if (width !== undefined && height !== undefined) resolution = `${width}x${height}`;
            else if (requestedResolution !== undefined) resolution = requestedResolution;
            controls.resolution = resolution;
            if (cameraPreset) {
                const pose = cameraPresets[cameraPreset];
                camera.setPose(pose.position, pose.yaw, pose.pitch);
                controls.camera = cameraPreset;
            }
            recreate(); gui.updateDisplay();
        },
        pause() { manual = true; renderer.stop(); },
        resume() { manual = false; recreate(); },
        render(time = settings.fixedTime) { renderer.renderOnce(0, time); },
        setStatus: status,
    };
    gui.add(settings, 'mode', ['naive', 'forward+', 'clustered deferred']).name('Renderer').onChange(recreate);
    gui.add(lights, 'numLights', 0, Lights.maxNumLights, 1).name('Point lights').onChange(() => lights.updateLightSetUniformNumLights());
    gui.add(controls, 'camera', Object.keys(cameraPresets)).name('Camera preset').onChange((name: string) => {
        const pose = cameraPresets[name]; camera.setPose(pose.position, pose.yaw, pose.pitch);
    });
    gui.add(controls, 'resolution', { 'Fit window': 'window', '1280 × 720': '1280x720', '1920 × 1080': '1920x1080' }).name('Resolution').onChange((value: string) => { resolution = value; applySize(); });
    gui.add(settings, 'freezeLights').name('Freeze lights');
    const optimization = gui.addFolder('Rendering options');
    optimization.add(settings, 'clusterGrid', ['8x4x16', '16x9x24', '32x18x24']).name('Cluster grid').onChange(recreate);
    optimization.add(settings, 'bundles').name('Render bundles').onChange(recreate);
    optimization.add(settings, 'optimizedLightMath').name('Fast light rejection').onChange(recreate);
    const depthControl = optimization.add(settings, 'depthMode', { Disabled: 'off', 'Prepass only': 'prepass', 'Prepass + culling': 'culling' }).name('Forward+ depth').onChange(recreate);
    const computeControl = optimization.add(settings, 'deferredCompute').name('Compute lighting').onChange(recreate);
    const compactControl = optimization.add(settings, 'compactGBuffer').name('Compact G-buffer').onChange(recreate); optimization.open();
    const effect = gui.addFolder('Bloom');
    effect.add(settings, 'bloom').name('Enable bloom');
    effect.add(settings, 'bloomThreshold', 0, 2, 0.05).name('Brightness threshold');
    effect.add(settings, 'bloomStrength', 0, 1, 0.02).name('Strength'); effect.open();
    const debugControl = gui.add(settings, 'debugView', debugViews).name('Debug view');
    function updateApplicability() {
        for (const [control, applicable] of [[depthControl, settings.mode === 'forward+'], [computeControl, settings.mode === 'clustered deferred'], [compactControl, settings.mode === 'clustered deferred']] as const) {
            const row = control.domElement.closest('li') as HTMLElement | null;
            if (row) { row.inert = !applicable; row.classList.toggle('inactive-setting', !applicable); row.title = applicable ? '' : 'Applies to the other rendering pipeline'; }
        }
        const supported = settings.mode === 'naive' ? ['none', 'bloom'] : debugViews.filter(view => view !== 'active-clusters' || (settings.mode === 'forward+' && settings.depthMode === 'culling'));
        if (!supported.includes(settings.debugView)) settings.debugView = 'none';
        const select = debugControl.domElement.querySelector('select');
        if (select) for (const option of select.options) option.disabled = !supported.includes(option.value);
        debugControl.updateDisplay();
    }
    const gpuName = String((adapterInfo as GPUAdapterInfo | undefined)?.vendor || 'WebGPU');
    document.getElementById('adapterValue')!.textContent = `${gpuName} GPU`;
    let displayTime = 0;
    let occupancyTime = 0;
    let occupancyPending = false;
    profiler.onSample = sample => {
        if (performance.now() - displayTime < 250) return;
        displayTime = performance.now();
        document.getElementById('gpuTime')!.textContent = sample.renderMs === null ? 'Unavailable' : `${sample.renderMs.toFixed(2)} ms`;
        document.getElementById('cpuTime')!.textContent = `${sample.cpuMs.toFixed(2)} ms`;
        if (!busy && !occupancyPending && performance.now() - occupancyTime > 2000 && settings.mode === 'forward+' && settings.depthMode === 'culling') {
            occupancyTime = performance.now(); occupancyPending = true;
            const mask = (renderer as ForwardPlusRenderer).activeMaskBuffer;
            if (mask) readBuffer(mask).then(data => {
                const flags = new Uint32Array(data); const active = flags.filter(value => value !== 0).length;
                document.getElementById('occupancyValue')!.textContent = `${active}/${flags.length} active clusters`;
            }).catch(() => {}).finally(() => { occupancyPending = false; });
            else occupancyPending = false;
        } else if (settings.mode !== 'forward+' || settings.depthMode !== 'culling') document.getElementById('occupancyValue')!.textContent = 'Full clustering';
    };
    let busy = false;
    async function task(name: string, callback: () => Promise<unknown>) {
        if (busy) return;
        busy = true; gui.domElement.inert = true; camera.inputEnabled = false; camera.keys = {}; document.exitPointerLock(); canvas.style.pointerEvents = 'none';
        document.querySelectorAll<HTMLButtonElement>('.tools button').forEach(b => b.disabled = true);
        try {
            const result = await callback(); document.getElementById('result')!.textContent = JSON.stringify(result); status(`${name} complete`);
        } catch (error) {
            status(`${name}: ${String(error)}`); document.getElementById('result')!.textContent = JSON.stringify({ error: String(error) }); console.error(error);
        } finally {
            busy = false; gui.domElement.inert = false; camera.inputEnabled = true; canvas.style.pointerEvents = '';
            document.querySelectorAll<HTMLButtonElement>('.tools button').forEach(b => b.disabled = false);
            if (!profiler.supported) for (const id of ['benchmark', 'benchmarkQuick', 'capacityStudy']) (document.getElementById(id) as HTMLButtonElement).disabled = true;
        }
    }
    document.getElementById('validate')!.addEventListener('click', () => task('Validation', () => runValidation(app)));
    document.getElementById('benchmark')!.addEventListener('click', () => task('Benchmark', () => runBenchmark(app, 'full')));
    document.getElementById('benchmarkQuick')!.addEventListener('click', () => task('Quick benchmark', () => runBenchmark(app, 'quick')));
    document.getElementById('capacityStudy')!.addEventListener('click', () => task('Capacity study', () => runBenchmark(app, 'capacity')));
    document.getElementById('screenshot')!.addEventListener('click', () => task('Screenshot', () => captureScreenshot(app)));
    document.getElementById('record')!.addEventListener('click', () => task('Demo recording', () => captureDemo(app)));
    Object.assign(window, { project: { app, settings, profiler, device, adapterInfo,
        validate: () => runValidation(app), benchmark: (scope: 'full' | 'quick' = 'full') => runBenchmark(app, scope),
        screenshot: () => captureScreenshot(app), record: () => captureDemo(app), saveEvidence,
    } });
    recreate();
    new ResizeObserver(() => { if (!busy && resolution === 'window') applySize(); }).observe(document.getElementById('viewport')!);
    status('Ready. Hold the mouse button to look around; W/A/S/D move, Q/E rise and fall.');
}
start().catch(error => {
    status(`Unable to start: ${String(error)}`);
    document.getElementById('unsupported')!.hidden = false;
    document.getElementById('unsupported')!.textContent = `This demo needs WebGPU and a compatible GPU. Open it in a current Chrome browser. ${String(error)}`;
    console.error(error);
});
