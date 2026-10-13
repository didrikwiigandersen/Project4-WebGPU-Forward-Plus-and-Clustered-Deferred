import { PostProcessing } from './post_processing';
import { profiler } from './profiler';
import { settings } from './settings';
import { Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { Stage } from './stage/stage';

export let canvas: HTMLCanvasElement;
export let canvasFormat: GPUTextureFormat;
export let context: GPUCanvasContext;
export let device: GPUDevice;
export let canvasTextureView: GPUTextureView;

export let adapterInfo: GPUAdapterInfo | undefined;
export let timestampQuery = false;
export let deviceLost = false;
export let deviceLostInfo: GPUDeviceLostInfo | undefined;
export const gpuErrors: string[] = [];
export function getGPUerrors(): string[] {
    return gpuErrors;
}
export const capabilities = {
    timestampQuery: false,
};

export let aspectRatio: number;
export const fovYDegrees = 45;

export let modelBindGroupLayout: GPUBindGroupLayout;
export let materialBindGroupLayout: GPUBindGroupLayout;

const outputTextureFormat: GPUTextureFormat = 'rgba16float';

function reportWebGPUError(message: string, error?: unknown): void {
    gpuErrors.push(message);
    if (error === undefined) {
        console.error(message);
    } else {
        console.error(message, error);
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('webgpu-error', {
            detail: { message, error },
        }));
    }
}

function showWebGPUInitializationError(message: string): void {
    reportWebGPUError(message);

    const existing = document.getElementById('webgpu-error-message');
    const errorMessageElement = existing ?? document.createElement('div');
    errorMessageElement.id = 'webgpu-error-message';
    errorMessageElement.setAttribute('role', 'alert');
    errorMessageElement.textContent = message;
    errorMessageElement.style.padding = '0.8em';
    errorMessageElement.style.margin = '0.8em';
    errorMessageElement.style.color = '#fff';
    errorMessageElement.style.background = '#8b1a1a';
    errorMessageElement.style.fontFamily = 'sans-serif';

    // Keep the rest of the page intact so that project instructions and controls
    // remain available when WebGPU initialization fails.
    if (!existing) {
        (document.body ?? document.documentElement).prepend(errorMessageElement);
    }
}

function clampTextureDimension(value: number, maximum: number): number {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function currentPixelRatio(): number {
    return Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
}

function desiredDrawingBufferSize(width?: number, height?: number): [number, number] {
    const pixelRatio = currentPixelRatio();
    const requestedWidth = width ?? canvas.clientWidth * pixelRatio;
    const requestedHeight = height ?? canvas.clientHeight * pixelRatio;
    const maximum = device.limits.maxTextureDimension2D;

    return [
        clampTextureDimension(requestedWidth, maximum),
        clampTextureDimension(requestedHeight, maximum),
    ];
}

// CHECKITOUT: this function initializes WebGPU and also creates some bind group layouts shared by all the renderers
export async function initWebGPU(): Promise<void> {
    const canvasElement = document.getElementById('mainCanvas');
    if (!(canvasElement instanceof HTMLCanvasElement)) {
        const message = 'Could not find the WebGPU canvas (#mainCanvas).';
        showWebGPUInitializationError(message);
        throw new Error(message);
    }
    canvas = canvasElement;

    if (!navigator.gpu) {
        const message = "This browser doesn't support WebGPU. Try using an up-to-date version of Google Chrome.";
        showWebGPUInitializationError(message);
        throw new Error('WebGPU not supported on this browser');
    }

    if (!navigator.gpu.wgslLanguageFeatures?.has('unrestricted_pointer_parameters')) {
        const message = 'This browser lacks the WGSL unrestricted_pointer_parameters feature required by the lighting shaders. Use a current version of Chrome.';
        showWebGPUInitializationError(message);
        throw new Error('Required WGSL language feature unavailable: unrestricted_pointer_parameters');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        const message = 'No appropriate WebGPU adapter was found.';
        showWebGPUInitializationError(message);
        throw new Error(message);
    }

    adapterInfo = adapter.info;
    timestampQuery = adapter.features.has('timestamp-query');
    capabilities.timestampQuery = timestampQuery;
    const requiredFeatures: GPUFeatureName[] = timestampQuery
        ? ['timestamp-query']
        : [];

    try {
        device = await adapter.requestDevice({ requiredFeatures });
    } catch (error) {
        const message = 'Unable to create a WebGPU device.';
        showWebGPUInitializationError(message);
        reportWebGPUError(message, error);
        throw error;
    }

    deviceLost = false;
    deviceLostInfo = undefined;
    device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
        reportWebGPUError(`Uncaptured WebGPU error: ${event.error.message}`, event.error);
    });
    void device.lost.then(info => {
        deviceLost = true;
        deviceLostInfo = info;
        const message = `WebGPU device lost (${info.reason}): ${info.message || 'no additional information'}`;
        reportWebGPUError(message, info);
        window.dispatchEvent(new CustomEvent('webgpu-device-lost', { detail: info }));
    });

    const canvasContext = canvas.getContext('webgpu');
    if (!canvasContext) {
        const message = 'Unable to create a WebGPU canvas context.';
        showWebGPUInitializationError(message);
        throw new Error(message);
    }
    context = canvasContext;
    canvasFormat = navigator.gpu.getPreferredCanvasFormat();

    const [width, height] = desiredDrawingBufferSize();
    canvas.width = width;
    canvas.height = height;
    aspectRatio = width / height;

    context.configure({
        device,
        format: canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        alphaMode: 'opaque',
    });

    console.info('WebGPU initialized', {
        adapter: adapterInfo,
        timestampQuery,
    });

    modelBindGroupLayout = device.createBindGroupLayout({
        label: 'model bind group layout',
        entries: [
            { // modelMat
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            },
        ],
    });

    materialBindGroupLayout = device.createBindGroupLayout({
        label: 'material bind group layout',
        entries: [
            { // diffuseTex
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {},
            },
            { // diffuseTexSampler
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {},
            },
        ],
    });
}

export const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
        { // pos
            format: 'float32x3',
            offset: 0,
            shaderLocation: 0,
        },
        { // nor
            format: 'float32x3',
            offset: 12,
            shaderLocation: 1,
        },
        { // uv
            format: 'float32x2',
            offset: 24,
            shaderLocation: 2,
        },
    ],
};

export abstract class Renderer {
    protected readonly scene: Scene;
    protected readonly lights: Lights;
    protected readonly camera: Camera;
    protected readonly stats: Stats;

    public outputTexture: GPUTexture;
    public outputView: GPUTextureView;

    protected readonly postProcessing: PostProcessing;

    private outputWidth: number;
    private outputHeight: number;
    private previousFrameTime: number | undefined;
    private frameRequestId: number | undefined;
    private stopped = false;
    private disposed = false;
    private explicitDrawingBufferSize?: [number, number];

    constructor(stage: Stage) {
        this.scene = stage.scene;
        this.lights = stage.lights;
        this.camera = stage.camera;
        this.stats = stage.stats;

        this.outputWidth = Math.max(1, canvas.width);
        this.outputHeight = Math.max(1, canvas.height);
        this.outputTexture = this.createOutputTexture(this.outputWidth, this.outputHeight);
        this.outputView = this.outputTexture.createView();
        this.postProcessing = new PostProcessing(this.outputWidth, this.outputHeight);

        // Do not invoke the overridable onResize hook here: subclass fields have not
        // been initialized until after super() returns.
        this.camera.resize(this.outputWidth, this.outputHeight);
        this.scheduleFrame();
    }

    private createOutputTexture(width: number, height: number): GPUTexture {
        return device.createTexture({
            label: `${this.constructor.name} HDR output`,
            size: [width, height],
            format: outputTextureFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
                | GPUTextureUsage.TEXTURE_BINDING
                | GPUTextureUsage.STORAGE_BINDING
                | GPUTextureUsage.COPY_SRC,
        });
    }

    private scheduleFrame(): void {
        if (this.stopped || this.disposed || deviceLost || this.frameRequestId !== undefined) {
            return;
        }
        this.frameRequestId = requestAnimationFrame(time => this.onAnimationFrame(time));
    }

    private onAnimationFrame(time: number): void {
        this.frameRequestId = undefined;
        if (this.stopped || this.disposed || deviceLost) {
            return;
        }

        const deltaTime = this.previousFrameTime === undefined
            ? 0
            : Math.max(0, time - this.previousFrameTime);
        this.previousFrameTime = time;

        try {
            this.renderOnce(deltaTime, time);
        } catch (error) {
            this.stop();
            reportWebGPUError(`${this.constructor.name} stopped after a frame error.`, error);
            return;
        }

        // stop() can be called while a frame is executing, so check state again
        // instead of unconditionally scheduling the next callback.
        this.scheduleFrame();
    }

    stop(): void {
        this.stopped = true;
        if (this.frameRequestId !== undefined) {
            cancelAnimationFrame(this.frameRequestId);
            this.frameRequestId = undefined;
        }
    }

    public renderOnce(deltaTime = 0, time = settings.fixedTime): void {
        if (this.disposed || deviceLost) {
            return;
        }

        this.ensureDrawingBufferSize();

        profiler.beginFrame({
            renderer: this.constructor.name,
            width: this.outputWidth,
            height: this.outputHeight,
            lights: this.lights.numLights,
        });
        this.camera.onFrame(deltaTime);
        this.lights.onFrame(time);

        const cpuStart = performance.now();
        this.stats.begin();
        try {
            this.draw();
        } finally {
            this.stats.end();
            profiler.endCPU(performance.now() - cpuStart);
        }
    }

    public resize(width?: number, height?: number): void {
        if (this.disposed) {
            return;
        }

        if (width === undefined && height === undefined) {
            // Returning to automatic sizing is explicit. Subsequent frames use
            // the current CSS size and DPR until another fixed size is selected.
            this.explicitDrawingBufferSize = undefined;
        } else {
            if (width === undefined || height === undefined) {
                throw new Error('Renderer.resize requires both width and height, or neither.');
            }
            this.explicitDrawingBufferSize = desiredDrawingBufferSize(width, height);
        }

        this.ensureDrawingBufferSize();
    }

    private ensureDrawingBufferSize(): void {
        const [nextWidth, nextHeight] = this.explicitDrawingBufferSize
            ?? desiredDrawingBufferSize();

        if (canvas.width !== nextWidth) {
            canvas.width = nextWidth;
        }
        if (canvas.height !== nextHeight) {
            canvas.height = nextHeight;
        }
        aspectRatio = nextWidth / nextHeight;

        if (nextWidth === this.outputWidth && nextHeight === this.outputHeight) {
            return;
        }

        this.outputWidth = nextWidth;
        this.outputHeight = nextHeight;
        this.camera.resize(nextWidth, nextHeight);

        const previousOutput = this.outputTexture;
        this.outputTexture = this.createOutputTexture(nextWidth, nextHeight);
        this.outputView = this.outputTexture.createView();
        previousOutput.destroy();

        this.postProcessing.resize(nextWidth, nextHeight);
        this.onResize();
    }

    protected finishFrame(encoder: GPUCommandEncoder): void {
        // Preserve the starter export for integrations that inspect the currently
        // acquired swap-chain view. PostProcessing may create an additional view of
        // this same current texture for its presentation pass.
        canvasTextureView = context.getCurrentTexture().createView();
        this.postProcessing.render(encoder, this.outputTexture);
        profiler.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        profiler.afterSubmit();
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.stop();
        this.disposed = true;
        this.onDispose();
        this.outputTexture.destroy();
        this.postProcessing.dispose();
    }

    protected abstract draw(): void;

    protected onResize(): void {
        // Optional subclass hook.
    }

    protected onDispose(): void {
        // Optional subclass hook.
    }
}
