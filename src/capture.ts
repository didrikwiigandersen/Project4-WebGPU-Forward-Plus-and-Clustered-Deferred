import type { Configuration, ProjectApp } from './app_api';
import { saveEvidence } from './app_api';
import { settings } from './settings';
import { canvas } from './renderer';
import { canvasPixels, pngBlob } from './gpu_io';
import { profiler } from './profiler';

function recordCleanupError(errors: unknown[], action: () => void): void {
    try {
        action();
    } catch (error) {
        errors.push(error);
    }
}

function finishCleanup(context: string, primaryFailed: boolean, errors: unknown[]): void {
    if (errors.length === 0) return;
    if (primaryFailed) {
        console.error(`${context} cleanup also failed`, errors);
        return;
    }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${context} cleanup failed`);
}

function captureError(error: unknown, fallback: string): Error {
    return error instanceof Error
        ? error
        : new Error(error === undefined ? fallback : `${fallback} ${String(error)}`);
}

function recorderEventError(event: Event): Error {
    return captureError(
        (event as Event & { error?: unknown }).error,
        'MediaRecorder reported an error.',
    );
}

export async function captureScreenshot(app: ProjectApp, name = 'sponza.png') {
    let primaryFailed = false;
    try {
        app.pause();
        await profiler.drain();
        app.render();
        const bytes = await canvasPixels();
        await saveEvidence(`media/${name}`, await pngBlob(bytes));
        return { file: `docs/media/${name}`, width: canvas.width, height: canvas.height };
    } catch (error) {
        primaryFailed = true;
        throw error;
    } finally {
        const cleanupErrors: unknown[] = [];
        recordCleanupError(cleanupErrors, () => app.resume());
        finishCleanup('Screenshot capture', primaryFailed, cleanupErrors);
    }
}

type DemoConfiguration = typeof settings & Required<Pick<
    Configuration,
    'lightCount' | 'width' | 'height' | 'cameraPreset'
>>;

interface DemoPhase {
    label: string;
    configuration: DemoConfiguration;
}

export async function captureDemo(app: ProjectApp) {
    const previous = {
        settings: { ...settings },
        lightCount: app.lights.numLights,
        cameraPosition: [
            Number(app.camera.cameraPos[0]),
            Number(app.camera.cameraPos[1]),
            Number(app.camera.cameraPos[2]),
        ] as [number, number, number],
        yaw: app.camera.yaw,
        pitch: app.camera.pitch,
        resolution: app.resolution,
        inputEnabled: app.camera.inputEnabled,
    };

    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    let pendingAnimationFrame: number | undefined;
    let rejectPendingAnimationFrame: ((reason?: unknown) => void) | undefined;
    let recorderStopRequested = false;
    let primaryFailed = false;

    const cancelPendingFrame = (reason: unknown): void => {
        const animationFrame = pendingAnimationFrame;
        const reject = rejectPendingAnimationFrame;
        pendingAnimationFrame = undefined;
        rejectPendingAnimationFrame = undefined;
        if (animationFrame !== undefined) {
            try {
                cancelAnimationFrame(animationFrame);
            } catch {
                // Cleanup below records cancellation failures on the final path.
            }
        }
        reject?.(reason);
    };

    try {
        app.pause();
        app.camera.inputEnabled = false;
        await profiler.drain();

        const sourceCanvas = canvas;
        if (!sourceCanvas) throw new Error('The WebGPU canvas is unavailable for demo capture.');

        const video = document.createElement('canvas');
        video.width = 1280;
        video.height = 720;
        const context2d = video.getContext('2d');
        if (!context2d) throw new Error('Demo capture requires a 2D canvas context.');
        if (typeof video.captureStream !== 'function') {
            throw new Error('Demo capture is unavailable because canvas.captureStream is unsupported.');
        }
        if (typeof MediaRecorder === 'undefined') {
            throw new Error('Demo capture is unavailable because MediaRecorder is unsupported.');
        }
        if (typeof MediaRecorder.isTypeSupported !== 'function') {
            throw new Error('Demo capture cannot determine supported WebM recording formats.');
        }

        const mimeTypes = ['video/webm;codecs=vp9', 'video/webm'];
        const mimeType = mimeTypes.find(candidate => MediaRecorder.isTypeSupported(candidate));
        if (!mimeType) throw new Error('Demo capture requires MediaRecorder WebM support.');

        stream = video.captureStream(30);
        recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 5_000_000,
        });

        const chunks: BlobPart[] = [];
        let rejectRecorderFailure: (reason?: unknown) => void = () => undefined;
        const recorderFailure = new Promise<never>((_resolve, reject) => {
            rejectRecorderFailure = reject;
        });
        // Attach a handler immediately so an error raised before the first frame
        // race never becomes an unhandled rejection.
        void recorderFailure.catch(() => undefined);

        let resolveRecorderStopped: (blob: Blob) => void = () => undefined;
        const recorderStopped = new Promise<Blob>(resolve => {
            resolveRecorderStopped = resolve;
        });

        const failRecording = (error: Error): void => {
            rejectRecorderFailure(error);
            cancelPendingFrame(error);
        };

        recorder.ondataavailable = event => {
            try {
                chunks.push(event.data);
            } catch (error) {
                failRecording(captureError(error, 'MediaRecorder data collection failed.'));
            }
        };
        recorder.onerror = event => {
            failRecording(recorderEventError(event));
        };
        recorder.onstop = () => {
            try {
                resolveRecorderStopped(new Blob(chunks, { type: mimeType }));
                if (!recorderStopRequested) {
                    failRecording(new Error('MediaRecorder stopped before the feature tour completed.'));
                }
            } catch (error) {
                failRecording(captureError(error, 'MediaRecorder finalization failed.'));
            }
        };

        const baseConfiguration: DemoConfiguration = {
            mode: 'naive',
            bundles: false,
            optimizedLightMath: true,
            depthMode: 'off',
            deferredCompute: false,
            compactGBuffer: false,
            bloom: false,
            bloomThreshold: 1,
            bloomStrength: 0.2,
            debugView: 'none',
            clusterGrid: '16x9x24',
            freezeLights: false,
            fixedTime: 1000,
            lightCount: 1024,
            width: 1280,
            height: 720,
            cameraPreset: 'Atrium',
        };
        const phases: DemoPhase[] = [
            {
                label: 'Naive forward · 1,024 point lights',
                configuration: { ...baseConfiguration, mode: 'naive' },
            },
            {
                label: 'Forward+ · cluster light lists',
                configuration: { ...baseConfiguration, mode: 'forward+', depthMode: 'off' },
            },
            {
                label: 'Forward+ · depth prepass and active-cluster culling',
                configuration: { ...baseConfiguration, mode: 'forward+', depthMode: 'culling' },
            },
            {
                label: 'Occupied visible cluster IDs · depth-based culling',
                configuration: {
                    ...baseConfiguration,
                    mode: 'forward+',
                    depthMode: 'culling',
                    debugView: 'active-clusters',
                },
            },
            {
                label: 'Clustered deferred · baseline MRT and fullscreen lighting',
                configuration: {
                    ...baseConfiguration,
                    mode: 'clustered deferred',
                    compactGBuffer: false,
                    deferredCompute: false,
                },
            },
            {
                label: 'Compute deferred · 12-byte compact G-buffer',
                configuration: {
                    ...baseConfiguration,
                    mode: 'clustered deferred',
                    compactGBuffer: true,
                    deferredCompute: true,
                },
            },
            {
                label: 'Decoded octahedral normals',
                configuration: {
                    ...baseConfiguration,
                    mode: 'clustered deferred',
                    compactGBuffer: true,
                    deferredCompute: true,
                    debugView: 'normals',
                },
            },
            {
                label: 'Render bundles · reusable geometry commands',
                configuration: {
                    ...baseConfiguration,
                    mode: 'clustered deferred',
                    compactGBuffer: true,
                    deferredCompute: true,
                    bundles: true,
                },
            },
            {
                label: 'Compute bloom · Gaussian highlight blur',
                configuration: {
                    ...baseConfiguration,
                    mode: 'clustered deferred',
                    compactGBuffer: true,
                    deferredCompute: true,
                    bundles: false,
                    bloom: true,
                },
            },
            {
                label: '5,000 lights · compact compute deferred and bloom',
                configuration: {
                    ...baseConfiguration,
                    mode: 'clustered deferred',
                    compactGBuffer: true,
                    deferredCompute: true,
                    bundles: false,
                    bloom: true,
                    lightCount: 5000,
                },
            },
        ];

        const drawFrame = (label: string): Promise<void> => new Promise((resolve, reject) => {
            try {
                const animationFrame = requestAnimationFrame(frameTime => {
                    pendingAnimationFrame = undefined;
                    rejectPendingAnimationFrame = undefined;
                    try {
                        app.render(frameTime);
                        context2d.drawImage(sourceCanvas, 0, 0, video.width, video.height);
                        context2d.fillStyle = 'rgba(23,42,59,0.92)';
                        context2d.fillRect(0, 0, video.width, 65);
                        context2d.fillStyle = '#f3f7fa';
                        context2d.font = '22px Avenir Next, sans-serif';
                        context2d.fillText(label, 24, 30);
                        context2d.font = '14px Avenir Next, sans-serif';
                        context2d.fillText(
                            'Didrik Wiig-Andersen · CIS 5650 · github.com/didrikwiigandersen',
                            24,
                            52,
                        );
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
                pendingAnimationFrame = animationFrame;
                rejectPendingAnimationFrame = reject;
            } catch (error) {
                pendingAnimationFrame = undefined;
                rejectPendingAnimationFrame = undefined;
                reject(error);
            }
        });

        recorder.start(1000);
        const chapterDurationMs = 5000;
        for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
            const phase = phases[phaseIndex];
            app.configure(phase.configuration);
            app.pause();
            app.setStatus(`Recording ${phaseIndex + 1}/${phases.length}: ${phase.label}`);

            const started = performance.now();
            while (performance.now() - started < chapterDurationMs) {
                await Promise.race([
                    drawFrame(phase.label),
                    recorderFailure,
                ]);
            }
        }

        if (recorder.state === 'inactive') {
            throw new Error('MediaRecorder became inactive before the feature tour could be finalized.');
        }
        recorderStopRequested = true;
        recorder.stop();
        const blob = await Promise.race([recorderStopped, recorderFailure]);
        await saveEvidence('media/feature-tour.webm', blob);
        return {
            file: 'docs/media/feature-tour.webm',
            durationSeconds: phases.length * chapterDurationMs / 1000,
            bytes: blob.size,
        };
    } catch (error) {
        primaryFailed = true;
        throw error;
    } finally {
        const cleanupErrors: unknown[] = [];

        if (pendingAnimationFrame !== undefined) {
            recordCleanupError(cleanupErrors, () => cancelAnimationFrame(pendingAnimationFrame!));
            pendingAnimationFrame = undefined;
        }
        rejectPendingAnimationFrame?.(new Error('Demo capture was cancelled during cleanup.'));
        rejectPendingAnimationFrame = undefined;

        if (recorder) {
            recordCleanupError(cleanupErrors, () => {
                if (recorder!.state !== 'inactive') {
                    recorderStopRequested = true;
                    recorder!.stop();
                }
            });
        }
        if (stream) {
            let tracks: MediaStreamTrack[] = [];
            recordCleanupError(cleanupErrors, () => {
                tracks = stream!.getTracks();
            });
            for (const track of tracks) {
                recordCleanupError(cleanupErrors, () => track.stop());
            }
        }

        recordCleanupError(cleanupErrors, () => app.configure({
            ...previous.settings,
            lightCount: previous.lightCount,
            resolution: previous.resolution,
        }));
        recordCleanupError(cleanupErrors, () => app.camera.setPose(
            previous.cameraPosition,
            previous.yaw,
            previous.pitch,
        ));
        recordCleanupError(cleanupErrors, () => app.resume());
        recordCleanupError(cleanupErrors, () => {
            app.camera.inputEnabled = previous.inputEnabled;
        });

        finishCleanup('Demo capture', primaryFailed, cleanupErrors);
    }
}
