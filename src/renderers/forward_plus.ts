import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { profiler } from '../profiler';
import { settings } from '../settings';
import { Stage } from '../stage/stage';
import { createGeometryBundle, drawGeometry } from './geometry';

const debugModeByName: Readonly<Record<string, number>> = {
    none: 0,
    clusters: 1,
    'light-count': 2,
    overflow: 3,
    albedo: 4,
    normals: 5,
    depth: 6,
    bloom: 7,
    'active-clusters': 8,
};

/** Forward shading restricted to the light list assigned to each cluster. */
export class ForwardPlusRenderer extends renderer.Renderer {
    private static readonly depthFormat: GPUTextureFormat = 'depth32float';
    private static readonly outputFormat: GPUTextureFormat = 'rgba16float';
    private static readonly maskFormat: GPUTextureFormat = 'r8unorm';

    readonly sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    private sceneUniformsBindGroup!: GPUBindGroup;
    private boundClustersBuffer?: GPUBuffer;
    private boundActiveMaskBuffer?: GPUBuffer;

    private readonly prepassSceneBindGroupLayout: GPUBindGroupLayout;
    private readonly prepassSceneBindGroup: GPUBindGroup;
    private readonly markerBindGroupLayout: GPUBindGroupLayout;
    private markerBindGroup!: GPUBindGroup;
    private readonly debugUniformBuffer: GPUBuffer;
    private readonly debugUniformData = new Uint32Array(4);

    public depthTexture!: GPUTexture;
    private depthTextureView!: GPUTextureView;
    private maskTexture!: GPUTexture;
    private maskTextureView!: GPUTextureView;

    /** One atomic u32 per cluster, exposed for deterministic validation/readback. */
    public activeMaskBuffer!: GPUBuffer;
    private activeMaskGrid = '';

    private readonly mainPipeline: GPURenderPipeline;
    private readonly mainPrepassPipeline: GPURenderPipeline;
    private readonly prepassPipeline: GPURenderPipeline;
    private readonly markerPipeline: GPURenderPipeline;

    private mainBundle?: GPURenderBundle;
    private mainPrepassBundle?: GPURenderBundle;
    private prepassBundle?: GPURenderBundle;

    constructor(stage: Stage) {
        super(stage);
        this.lights.ensureClusterResources();

        this.debugUniformBuffer = renderer.device.createBuffer({
            label: 'Forward+ debug uniform',
            size: this.debugUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        renderer.device.queue.writeBuffer(this.debugUniformBuffer, 0, this.debugUniformData);

        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Forward+ scene bind group layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform', minBindingSize: 16 },
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        // The prepass deliberately has no dependency on the cluster buffer. A
        // grid change can therefore replace/destroy that buffer after depth has
        // already been encoded without invalidating the prepass bind group.
        this.prepassSceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Forward+ prepass scene bind group layout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });
        this.prepassSceneBindGroup = renderer.device.createBindGroup({
            label: 'Forward+ prepass scene bind group',
            layout: this.prepassSceneBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this.camera.uniformsBuffer },
            }],
        });

        this.markerBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Forward+ active cluster marker bind group layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'depth' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'storage' },
                },
            ],
        });

        const mainPipelineLayout = renderer.device.createPipelineLayout({
            label: 'Forward+ pipeline layout',
            bindGroupLayouts: [
                this.sceneUniformsBindGroupLayout,
                renderer.modelBindGroupLayout,
                renderer.materialBindGroupLayout,
            ],
        });
        const vertexModule = renderer.device.createShaderModule({
            label: 'Forward+ geometry vertex shader',
            code: shaders.naiveVertSrc,
        });
        const fragmentModule = renderer.device.createShaderModule({
            label: 'Forward+ lighting fragment shader',
            code: shaders.forwardPlusFragSrc,
        });
        this.mainPipeline = this.createMainPipeline(
            'Forward+ pipeline (no prepass)',
            mainPipelineLayout,
            vertexModule,
            fragmentModule,
            true,
            'less',
        );
        this.mainPrepassPipeline = this.createMainPipeline(
            'Forward+ pipeline (equal-depth shading)',
            mainPipelineLayout,
            vertexModule,
            fragmentModule,
            false,
            'equal',
        );

        this.prepassPipeline = renderer.device.createRenderPipeline({
            label: 'Forward+ alpha-aware depth prepass pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Forward+ depth prepass pipeline layout',
                bindGroupLayouts: [
                    this.prepassSceneBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            vertex: {
                module: vertexModule,
                entryPoint: 'main',
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: 'Forward+ alpha-aware depth prepass fragment shader',
                    code: shaders.forwardPlusPrepassFragSrc,
                }),
                entryPoint: 'main',
                targets: [],
            },
            depthStencil: {
                format: ForwardPlusRenderer.depthFormat,
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        });

        this.markerPipeline = renderer.device.createRenderPipeline({
            label: 'Forward+ active cluster marker pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Forward+ active cluster marker pipeline layout',
                bindGroupLayouts: [this.markerBindGroupLayout],
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: 'Forward+ fullscreen quad marker vertex shader',
                    code: shaders.forwardPlusMarkerVertSrc,
                }),
                entryPoint: 'main',
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: 'Forward+ active cluster marker fragment shader',
                    code: shaders.forwardPlusMarkerFragSrc,
                }),
                entryPoint: 'main',
                targets: [{ format: ForwardPlusRenderer.maskFormat }],
            },
        });

        this.ensureActiveMask();
        this.ensureSceneBindGroup();
        this.recreateSizeDependentResources();
    }

    private createMainPipeline(
        label: string,
        layout: GPUPipelineLayout,
        vertexModule: GPUShaderModule,
        fragmentModule: GPUShaderModule,
        depthWriteEnabled: boolean,
        depthCompare: GPUCompareFunction,
    ): GPURenderPipeline {
        return renderer.device.createRenderPipeline({
            label,
            layout,
            vertex: {
                module: vertexModule,
                entryPoint: 'main',
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'main',
                constants: {
                    optimizedLightMath: settings.optimizedLightMath ? 1 : 0,
                },
                targets: [{ format: ForwardPlusRenderer.outputFormat }],
            },
            depthStencil: {
                format: ForwardPlusRenderer.depthFormat,
                depthWriteEnabled,
                depthCompare,
            },
        });
    }

    /** Rebuild bindings and bundles whenever either grid-dependent buffer changes. */
    private ensureSceneBindGroup(): void {
        const clustersBuffer = this.lights.clustersBuffer;
        if (
            clustersBuffer === this.boundClustersBuffer
            && this.activeMaskBuffer === this.boundActiveMaskBuffer
        ) return;

        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: 'Forward+ scene bind group',
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.camera.uniformsBuffer },
                },
                {
                    binding: 1,
                    resource: { buffer: this.lights.lightSetStorageBuffer },
                },
                {
                    binding: 2,
                    resource: { buffer: clustersBuffer },
                },
                {
                    binding: 3,
                    resource: { buffer: this.debugUniformBuffer },
                },
                {
                    binding: 4,
                    resource: { buffer: this.activeMaskBuffer },
                },
            ],
        });
        this.boundClustersBuffer = clustersBuffer;
        this.boundActiveMaskBuffer = this.activeMaskBuffer;
        this.mainBundle = undefined;
        this.mainPrepassBundle = undefined;
    }

    /** Reallocate even when two differently-shaped grids have equal products. */
    private ensureActiveMask(): void {
        const dimensions = this.lights.clusterDimensions;
        const grid = dimensions.join('x');
        if (grid === this.activeMaskGrid) return;

        if (this.activeMaskBuffer) this.activeMaskBuffer.destroy();
        this.activeMaskBuffer = renderer.device.createBuffer({
            label: `Forward+ active cluster flags (${grid})`,
            size: dimensions[0] * dimensions[1] * dimensions[2] * Uint32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.activeMaskGrid = grid;

        if (this.depthTexture) this.rebuildMarkerBindGroup();
    }

    private updateDebugUniform(): void {
        this.debugUniformData.fill(0);
        this.debugUniformData[0] = debugModeByName[settings.debugView] ?? 0;
        this.debugUniformData[1] = settings.depthMode === 'culling' ? 1 : 0;
        renderer.device.queue.writeBuffer(this.debugUniformBuffer, 0, this.debugUniformData);
    }

    private recreateSizeDependentResources(): void {
        if (this.depthTexture) this.depthTexture.destroy();
        if (this.maskTexture) this.maskTexture.destroy();

        const width = Math.max(1, renderer.canvas.width);
        const height = Math.max(1, renderer.canvas.height);
        this.depthTexture = renderer.device.createTexture({
            label: 'Forward+ depth texture',
            size: [width, height],
            format: ForwardPlusRenderer.depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
                | GPUTextureUsage.TEXTURE_BINDING
                | GPUTextureUsage.COPY_SRC,
        });
        this.depthTextureView = this.depthTexture.createView();

        this.maskTexture = renderer.device.createTexture({
            label: 'Forward+ active cluster marker target',
            size: [width, height],
            format: ForwardPlusRenderer.maskFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
                | GPUTextureUsage.TEXTURE_BINDING
                | GPUTextureUsage.COPY_SRC,
        });
        this.maskTextureView = this.maskTexture.createView();
        this.rebuildMarkerBindGroup();
    }

    private rebuildMarkerBindGroup(): void {
        this.markerBindGroup = renderer.device.createBindGroup({
            label: 'Forward+ active cluster marker bind group',
            layout: this.markerBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.camera.uniformsBuffer },
                },
                {
                    binding: 1,
                    resource: this.depthTextureView,
                },
                {
                    binding: 2,
                    resource: { buffer: this.activeMaskBuffer },
                },
            ],
        });
    }

    private encodeDepthPrepass(encoder: GPUCommandEncoder): void {
        const pass = encoder.beginRenderPass({
            label: 'Forward+ depth prepass',
            timestampWrites: profiler.pass('Forward+ depth prepass'),
            colorAttachments: [],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        if (settings.bundles) {
            if (!this.prepassBundle) {
                this.prepassBundle = createGeometryBundle(
                    this.scene,
                    this.prepassPipeline,
                    this.prepassSceneBindGroup,
                    [],
                    ForwardPlusRenderer.depthFormat,
                );
            }
            pass.executeBundles([this.prepassBundle]);
        } else {
            pass.setPipeline(this.prepassPipeline);
            pass.setBindGroup(shaders.constants.bindGroup_scene, this.prepassSceneBindGroup);
            drawGeometry(pass, this.scene);
        }
        pass.end();
    }

    private encodeActiveClusterMarker(encoder: GPUCommandEncoder): void {
        encoder.clearBuffer(this.activeMaskBuffer);
        const pass = encoder.beginRenderPass({
            label: 'Forward+ active cluster marker pass',
            timestampWrites: profiler.pass('Forward+ active cluster marking'),
            colorAttachments: [{
                view: this.maskTextureView,
                clearValue: [0, 0, 0, 0],
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.markerPipeline);
        pass.setBindGroup(shaders.constants.bindGroup_scene, this.markerBindGroup);
        pass.draw(6);
        pass.end();
    }

    private encodeMainPass(encoder: GPUCommandEncoder, usePrepass: boolean): void {
        const pipeline = usePrepass ? this.mainPrepassPipeline : this.mainPipeline;
        const pass = encoder.beginRenderPass({
            label: 'Forward+ lighting pass',
            timestampWrites: profiler.pass('Forward+ shading'),
            colorAttachments: [{
                view: this.outputView,
                clearValue: [0, 0, 0, 0],
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: usePrepass ? {
                view: this.depthTextureView,
                depthReadOnly: true,
            } : {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        if (settings.bundles) {
            let bundle = usePrepass ? this.mainPrepassBundle : this.mainBundle;
            if (!bundle) {
                bundle = createGeometryBundle(
                    this.scene,
                    pipeline,
                    this.sceneUniformsBindGroup,
                    [ForwardPlusRenderer.outputFormat],
                    ForwardPlusRenderer.depthFormat,
                    usePrepass,
                );
                if (usePrepass) this.mainPrepassBundle = bundle;
                else this.mainBundle = bundle;
            }
            pass.executeBundles([bundle]);
        } else {
            pass.setPipeline(pipeline);
            pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            drawGeometry(pass, this.scene);
        }
        pass.end();
    }

    protected override draw(): void {
        // Grid-dependent buffers must be current before any pass captures them.
        this.lights.ensureClusterResources();
        this.ensureActiveMask();
        this.ensureSceneBindGroup();
        this.updateDebugUniform();

        const encoder = renderer.device.createCommandEncoder({ label: 'Forward+ frame encoder' });

        if (settings.depthMode === 'off') {
            this.lights.doLightClustering(encoder);
        } else {
            this.encodeDepthPrepass(encoder);
            if (settings.depthMode === 'culling') {
                this.encodeActiveClusterMarker(encoder);
                this.lights.doLightClustering(encoder, this.activeMaskBuffer);
            } else {
                this.lights.doLightClustering(encoder);
            }
        }

        // Lights may resize its cluster storage while encoding clustering for a
        // newly selected grid. Bind final shading to that new buffer now.
        this.ensureSceneBindGroup();
        this.encodeMainPass(encoder, settings.depthMode !== 'off');
        this.finishFrame(encoder);
    }

    protected override onResize(): void {
        this.recreateSizeDependentResources();
    }

    protected override onDispose(): void {
        this.depthTexture?.destroy();
        this.maskTexture?.destroy();
        this.activeMaskBuffer?.destroy();
        this.debugUniformBuffer.destroy();
        this.boundClustersBuffer = undefined;
        this.boundActiveMaskBuffer = undefined;
    }
}
