import { ProjectApp, saveEvidence } from './app_api';
import { settings } from './settings';
import { canvas } from './renderer';
import { canvasPixels, pngBlob } from './gpu_io';
import { profiler } from './profiler';

export async function captureScreenshot(app: ProjectApp, name = 'sponza.png') {
    app.pause(); await profiler.drain();
    try {
        app.render();
        const bytes = await canvasPixels();
        await saveEvidence(`media/${name}`, await pngBlob(bytes));
        return { file: `docs/media/${name}`, width: canvas.width, height: canvas.height };
    } finally { app.resume(); }
}
export async function captureDemo(app: ProjectApp) {
    const previous = { ...settings }, lightCount = app.lights.numLights, width = canvas.width, height = canvas.height;
    app.pause(); await profiler.drain();
    const video = document.createElement('canvas'); video.width = 1280; video.height = 720;
    const ctx = video.getContext('2d')!;
    const stream = video.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType })); });
    const phases = [
        { label: 'Naive forward · 1,024 point lights', mode: 'naive', lightCount: 1024, debugView: 'none' },
        { label: 'Forward+ · cluster light lists', mode: 'forward+', depthMode: 'off', debugView: 'none' },
        { label: 'Forward+ · depth prepass and active-cluster culling', mode: 'forward+', depthMode: 'culling', debugView: 'none' },
        { label: 'Visible clusters · depth-based culling', mode: 'forward+', depthMode: 'culling', debugView: 'active-clusters' },
        { label: 'Clustered deferred · baseline MRT and fullscreen lighting', mode: 'clustered deferred', compactGBuffer: false, deferredCompute: false, debugView: 'none' },
        { label: 'Compute deferred · 12-byte compact G-buffer', mode: 'clustered deferred', compactGBuffer: true, deferredCompute: true, debugView: 'none' },
        { label: 'Decoded octahedral normals', mode: 'clustered deferred', debugView: 'normals' },
        { label: 'Render bundles · reusable geometry commands', mode: 'clustered deferred', bundles: true, debugView: 'none' },
        { label: 'Compute bloom · Gaussian highlight blur', mode: 'clustered deferred', bloom: true, debugView: 'none' },
        { label: '5,000 lights · compact compute deferred and bloom', mode: 'clustered deferred', lightCount: 5000, bloom: true, debugView: 'none' },
    ];
    try {
        recorder.start(1000);
        for (let phase = 0; phase < phases.length; phase++) {
            const item = phases[phase];
            const { label, ...configuration } = item;
            app.configure({ ...configuration, width: 1280, height: 720, cameraPreset: 'Atrium', freezeLights: false } as Parameters<ProjectApp['configure']>[0]);
            app.pause();
            const started = performance.now();
            app.setStatus(`Recording ${phase + 1}/${phases.length}: ${label}`);
            while (performance.now() - started < 5000) {
                await new Promise<void>(resolve => requestAnimationFrame(() => {
                    app.render(performance.now());
                    ctx.drawImage(canvas, 0, 0, video.width, video.height);
                    ctx.fillStyle = 'rgba(23,42,59,0.92)'; ctx.fillRect(0, 0, video.width, 65);
                    ctx.fillStyle = '#f3f7fa'; ctx.font = '22px Avenir Next, sans-serif'; ctx.fillText(label, 24, 30);
                    ctx.font = '14px Avenir Next, sans-serif'; ctx.fillText('Didrik Wiig-Andersen · CIS 5650 · github.com/didrikwiigandersen', 24, 52);
                    resolve();
                }));
            }
        }
        recorder.stop();
        const blob = await finished;
        await saveEvidence('media/feature-tour.webm', blob);
        return { file: 'docs/media/feature-tour.webm', durationSeconds: 50, bytes: blob.size };
    } finally {
        if (recorder.state !== 'inactive') recorder.stop();
        stream.getTracks().forEach(track => track.stop());
        app.configure({ ...previous, lightCount, width, height }); app.resume();
    }
}
