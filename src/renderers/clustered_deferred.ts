import * as renderer from '../renderer';
import { profiler } from '../profiler';
import { settings } from '../settings';
import * as shaders from '../shaders/shaders';
import compactGBufferFragmentRaw from '../shaders/clustered_deferred_compact.fs.wgsl?raw';
import compactComputeRaw from '../shaders/clustered_deferred_compact_compute.cs.wgsl?raw';
import compactFullscreenFragmentRaw from '../shaders/clustered_deferred_compact_fullscreen.fs.wgsl?raw';
import baselineComputeRaw from '../shaders/clustered_deferred_compute.cs.wgsl?raw';
import lightingSharedRaw from '../shaders/clustered_deferred_lighting_shared.wgsl?raw';
import { Stage } from '../stage/stage';
import { createGeometryBundle, drawGeometry } from './geometry';

const depthFormat: GPUTextureFormat = 'depth32float';
const computeWorkgroupSize = 8;

const debugModeByName: Readonly<Record<string, number>> = {
    none: 0,
    clusters: 1,
    'light-count': 2,
    overflow: 3,
    albedo: 4,
    normals: 5,
    depth: 6,
    bloom: 0,
    'active-clusters': 8,
};

export class ClusteredDeferredRenderer extends renderer.Renderer {
    private readonly compact: boolean;
    private readonly computeLighting: boolean;
    private readonly useBundles: boolean;

    private readonly sceneBindGroupLayout: GPUBindGroupLayout;
    private readonly lightingBindGroupLayout: GPUBindGroupLayout;
    private sceneBindGroup: GPUBindGroup;
    private lightingBindGroup!: GPUBindGroup;
    private boundLightSetBuffer: GPUBuffer;
    private boundClusterSetBuffer: GPUBuffer;

    private readonly geometryPipeline: GPURenderPipeline;
    private readonly lightingRenderPipeline?: GPURenderPipeline;
    private readonly lightingComputePipeline?: GPUComputePipeline;
    private readonly geometryColorFormats: GPUTextureFormat[];
    private geometryBundle?: GPURenderBundle;

    private readonly deferredUniformBuffer: GPUBuffer;
    private readonly deferredUniformData = new Uint32Array(4);

    private positionTexture?: GPUTexture;
    private positionView?: GPUTextureView;
    private normalTexture?: GPUTexture;
    private normalView?: GPUTextureView;
    private albedoTexture?: GPUTexture;
    private albedoView?: GPUTextureView;
    private compactTexture?: GPUTexture;
    private compactView?: GPUTextureView;
    private depthTarget!: GPUTexture;
    private depthView!: GPUTextureView;
    private targetWidth = 1;
    private targetHeight = 1;

    public get depthTexture(): GPUTexture {
        return this.depthTarget;
    }

    constructor(stage: Stage) {
        super(stage);

        this.compact = settings.compactGBuffer;
        this.computeLighting = settings.deferredCompute;
        this.useBundles = settings.bundles;
        this.geometryColorFormats = this.compact
            ? ['rgba16uint']
            : ['rgba32float', 'rgba16float', 'rgba8unorm'];

        this.sceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Clustered deferred scene bind group layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        this.lights.ensureClusterResources();
        this.boundLightSetBuffer = this.lights.lightSetStorageBuffer;
        this.boundClusterSetBuffer = this.lights.clusterSetStorageBuffer;
        this.sceneBindGroup = this.createSceneBindGroup();

        this.deferredUniformBuffer = renderer.device.createBuffer({
            label: 'Clustered deferred debug and dimensions uniform',
            size: this.deferredUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.geometryPipeline = this.createGeometryPipeline();
        this.lightingBindGroupLayout = this.createLightingBindGroupLayout();

        const emptyBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Clustered deferred empty lighting bind group layout',
            entries: [],
        });
        const lightingPipelineLayout = renderer.device.createPipelineLayout({
            label: 'Clustered deferred lighting pipeline layout',
            bindGroupLayouts: [
                this.sceneBindGroupLayout,
                emptyBindGroupLayout,
                emptyBindGroupLayout,
                this.lightingBindGroupLayout,
            ],
        });

        if (this.computeLighting) {
            const variantRaw = this.compact ? compactComputeRaw : baselineComputeRaw;
            const source = shaders.processShaderRaw(`${lightingSharedRaw}\n${variantRaw}`);
            this.lightingComputePipeline = renderer.device.createComputePipeline({
                label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} compute lighting pipeline`,
                layout: lightingPipelineLayout,
                compute: {
                    module: renderer.device.createShaderModule({
                        label: this.compact
                            ? 'clustered_deferred_compact_compute.cs.wgsl'
                            : 'clustered_deferred_compute.cs.wgsl',
                        code: source,
                    }),
                    entryPoint: 'main',
                    constants: { optimizedLightMath: settings.optimizedLightMath ? 1 : 0 },
                },
            });
        } else {
            const fragmentSource = this.compact
                ? shaders.processShaderRaw(`${lightingSharedRaw}\n${compactFullscreenFragmentRaw}`)
                : shaders.clusteredDeferredFullscreenFragSrc;
            this.lightingRenderPipeline = renderer.device.createRenderPipeline({
                label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} fullscreen lighting pipeline`,
                layout: lightingPipelineLayout,
                primitive: { topology: 'triangle-list' },
                vertex: {
                    module: renderer.device.createShaderModule({
                        label: 'clustered_deferred_fullscreen.vs.wgsl',
                        code: shaders.clusteredDeferredFullscreenVertSrc,
                    }),
                    entryPoint: 'main',
                },
                fragment: {
                    module: renderer.device.createShaderModule({
                        label: this.compact
                            ? 'clustered_deferred_compact_fullscreen.fs.wgsl'
                            : 'clustered_deferred_fullscreen.fs.wgsl',
                        code: fragmentSource,
                    }),
                    entryPoint: 'main',
                    targets: [{ format: 'rgba16float' }],
                    constants: { optimizedLightMath: settings.optimizedLightMath ? 1 : 0 },
                },
            });
        }

        this.rebuildGeometryBundle();
        this.createSizeDependentResources();
    }

    private createSceneBindGroup(): GPUBindGroup {
        return renderer.device.createBindGroup({
            label: 'Clustered deferred scene bind group',
            layout: this.sceneBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.boundLightSetBuffer } },
                { binding: 2, resource: { buffer: this.boundClusterSetBuffer } },
            ],
        });
    }

    private createGeometryPipeline(): GPURenderPipeline {
        const fragmentSource = this.compact
            ? shaders.processShaderRaw(compactGBufferFragmentRaw)
            : shaders.clusteredDeferredFragSrc;
        return renderer.device.createRenderPipeline({
            label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} G-buffer pipeline`,
            layout: renderer.device.createPipelineLayout({
                label: 'Clustered deferred G-buffer pipeline layout',
                bindGroupLayouts: [
                    this.sceneBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: 'naive.vs.wgsl for clustered deferred G-buffer',
                    code: shaders.naiveVertSrc,
                }),
                entryPoint: 'main',
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: this.compact
                        ? 'clustered_deferred_compact.fs.wgsl'
                        : 'clustered_deferred.fs.wgsl',
                    code: fragmentSource,
                }),
                entryPoint: 'main',
                targets: this.geometryColorFormats.map(format => ({ format })),
            },
            depthStencil: {
                format: depthFormat,
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    private createLightingBindGroupLayout(): GPUBindGroupLayout {
        const visibility = this.computeLighting ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT;
        const entries: GPUBindGroupLayoutEntry[] = [];

        if (this.compact) {
            entries.push({
                binding: 0,
                visibility,
                texture: { sampleType: 'uint', viewDimension: '2d', multisampled: false },
            });
        } else {
            entries.push(
                {
                    binding: 0,
                    visibility,
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
                },
                {
                    binding: 1,
                    visibility,
                    texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
                },
                {
                    binding: 2,
                    visibility,
                    texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
                },
            );
        }

        entries.push(
            {
                binding: 3,
                visibility,
                texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
            },
            {
                binding: 4,
                visibility,
                buffer: { type: 'uniform', minBindingSize: 16 },
            },
        );
        if (this.computeLighting) {
            entries.push({
                binding: 5,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: {
                    access: 'write-only',
                    format: 'rgba16float',
                    viewDimension: '2d',
                },
            });
        }

        return renderer.device.createBindGroupLayout({
            label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} ${this.computeLighting ? 'compute' : 'fullscreen'} resources layout`,
            entries,
        });
    }

    private rebuildGeometryBundle(): void {
        this.geometryBundle = this.useBundles
            ? createGeometryBundle(
                this.scene,
                this.geometryPipeline,
                this.sceneBindGroup,
                this.geometryColorFormats,
                depthFormat,
            )
            : undefined;
    }

    private refreshSceneBindGroup(): void {
        const lightSetBuffer = this.lights.lightSetStorageBuffer;
        const clusterSetBuffer = this.lights.clusterSetStorageBuffer;
        if (lightSetBuffer === this.boundLightSetBuffer && clusterSetBuffer === this.boundClusterSetBuffer) {
            return;
        }

        this.boundLightSetBuffer = lightSetBuffer;
        this.boundClusterSetBuffer = clusterSetBuffer;
        this.sceneBindGroup = this.createSceneBindGroup();
        this.rebuildGeometryBundle();
    }

    private createSizeDependentResources(): void {
        this.targetWidth = Math.max(1, renderer.canvas.width);
        this.targetHeight = Math.max(1, renderer.canvas.height);
        const textureSize: GPUExtent3D = [this.targetWidth, this.targetHeight];
        const sampledAttachmentUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

        if (this.compact) {
            this.compactTexture = renderer.device.createTexture({
                label: 'Clustered deferred compact 8-byte color G-buffer',
                size: textureSize,
                format: 'rgba16uint',
                usage: sampledAttachmentUsage,
            });
            this.compactView = this.compactTexture.createView();
        } else {
            this.positionTexture = renderer.device.createTexture({
                label: 'Clustered deferred world-position G-buffer',
                size: textureSize,
                format: 'rgba32float',
                usage: sampledAttachmentUsage,
            });
            this.positionView = this.positionTexture.createView();

            this.normalTexture = renderer.device.createTexture({
                label: 'Clustered deferred world-normal G-buffer',
                size: textureSize,
                format: 'rgba16float',
                usage: sampledAttachmentUsage,
            });
            this.normalView = this.normalTexture.createView();

            this.albedoTexture = renderer.device.createTexture({
                label: 'Clustered deferred albedo G-buffer',
                size: textureSize,
                format: 'rgba8unorm',
                usage: sampledAttachmentUsage,
            });
            this.albedoView = this.albedoTexture.createView();
        }

        this.depthTarget = renderer.device.createTexture({
            label: 'Clustered deferred depth G-buffer',
            size: textureSize,
            format: depthFormat,
            usage: sampledAttachmentUsage | GPUTextureUsage.COPY_SRC,
        });
        this.depthView = this.depthTarget.createView();
        this.rebuildLightingBindGroup();
    }

    private rebuildLightingBindGroup(): void {
        const entries: GPUBindGroupEntry[] = [];
        if (this.compact) {
            entries.push({ binding: 0, resource: this.compactView! });
        } else {
            entries.push(
                { binding: 0, resource: this.positionView! },
                { binding: 1, resource: this.normalView! },
                { binding: 2, resource: this.albedoView! },
            );
        }
        entries.push(
            { binding: 3, resource: this.depthView },
            { binding: 4, resource: { buffer: this.deferredUniformBuffer } },
        );
        if (this.computeLighting) {
            entries.push({ binding: 5, resource: this.outputView });
        }

        this.lightingBindGroup = renderer.device.createBindGroup({
            label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} ${this.computeLighting ? 'compute' : 'fullscreen'} resources`,
            layout: this.lightingBindGroupLayout,
            entries,
        });
    }

    private destroySizeDependentResources(): void {
        this.positionTexture?.destroy();
        this.normalTexture?.destroy();
        this.albedoTexture?.destroy();
        this.compactTexture?.destroy();
        this.depthTarget?.destroy();

        this.positionTexture = undefined;
        this.positionView = undefined;
        this.normalTexture = undefined;
        this.normalView = undefined;
        this.albedoTexture = undefined;
        this.albedoView = undefined;
        this.compactTexture = undefined;
        this.compactView = undefined;
    }

    private updateDeferredUniforms(): void {
        this.deferredUniformData[0] = debugModeByName[settings.debugView] ?? 0;
        this.deferredUniformData[1] = this.targetWidth;
        this.deferredUniformData[2] = this.targetHeight;
        this.deferredUniformData[3] = 0;
        renderer.device.queue.writeBuffer(this.deferredUniformBuffer, 0, this.deferredUniformData);
    }

    private encodeGBufferPass(encoder: GPUCommandEncoder): void {
        const clearColor: GPUColor = { r: 0, g: 0, b: 0, a: 0 };
        const colorAttachments: GPURenderPassColorAttachment[] = this.compact
            ? [{
                view: this.compactView!,
                clearValue: clearColor,
                loadOp: 'clear',
                storeOp: 'store',
            }]
            : [this.positionView!, this.normalView!, this.albedoView!].map(view => ({
                view,
                clearValue: clearColor,
                loadOp: 'clear' as GPULoadOp,
                storeOp: 'store' as GPUStoreOp,
            }));

        const pass = encoder.beginRenderPass({
            label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} G-buffer pass`,
            colorAttachments,
            depthStencilAttachment: {
                view: this.depthView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
            timestampWrites: profiler.pass('G-buffer'),
        });

        if (this.geometryBundle) {
            pass.executeBundles([this.geometryBundle]);
        } else {
            pass.setPipeline(this.geometryPipeline);
            pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneBindGroup);
            drawGeometry(pass, this.scene);
        }
        pass.end();
    }

    private encodeLightingPass(encoder: GPUCommandEncoder): void {
        if (this.computeLighting) {
            const pass = encoder.beginComputePass({
                label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} compute lighting pass`,
                timestampWrites: profiler.pass('Deferred lighting'),
            });
            pass.setPipeline(this.lightingComputePipeline!);
            pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneBindGroup);
            pass.setBindGroup(3, this.lightingBindGroup);
            pass.dispatchWorkgroups(
                Math.ceil(this.targetWidth / computeWorkgroupSize),
                Math.ceil(this.targetHeight / computeWorkgroupSize),
            );
            pass.end();
            return;
        }

        const pass = encoder.beginRenderPass({
            label: `Clustered deferred ${this.compact ? 'compact' : 'baseline'} fullscreen lighting pass`,
            colorAttachments: [{
                view: this.outputView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            timestampWrites: profiler.pass('Deferred lighting'),
        });
        pass.setPipeline(this.lightingRenderPipeline!);
        pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneBindGroup);
        pass.setBindGroup(3, this.lightingBindGroup);
        pass.draw(6);
        pass.end();
    }

    protected override draw(): void {
        const encoder = renderer.device.createCommandEncoder({
            label: 'Clustered deferred frame command encoder',
        });

        this.lights.doLightClustering(encoder);
        this.refreshSceneBindGroup();
        this.updateDeferredUniforms();
        this.encodeGBufferPass(encoder);
        this.encodeLightingPass(encoder);
        this.finishFrame(encoder);
    }

    protected override onResize(): void {
        this.destroySizeDependentResources();
        this.createSizeDependentResources();
        this.refreshSceneBindGroup();
    }

    protected override onDispose(): void {
        this.destroySizeDependentResources();
        this.deferredUniformBuffer.destroy();
    }
}
