import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { profiler } from '../profiler';
import { settings } from '../settings';
import { Stage } from '../stage/stage';
import { createGeometryBundle, drawGeometry } from './geometry';

const depthFormat: GPUTextureFormat = 'depth24plus';

export class NaiveRenderer extends renderer.Renderer {
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup!: GPUBindGroup;

    depthTexture!: GPUTexture;
    depthTextureView!: GPUTextureView;

    pipeline: GPURenderPipeline;

    private boundClusterBuffer?: GPUBuffer;
    private geometryBundle?: GPURenderBundle;

    constructor(stage: Stage) {
        super(stage);
        this.lights.ensureClusterResources();

        // Keep group 0 ABI-compatible with every geometry renderer. The naive
        // fragment shader does not read clusters, but retaining binding 2 makes
        // renderer switches and validation use one unambiguous scene contract.
        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Naive scene bind group layout',
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
            ],
        });

        this.pipeline = renderer.device.createRenderPipeline({
            label: 'Naive pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Naive pipeline layout',
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: depthFormat,
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: 'Naive vertex shader',
                    code: shaders.naiveVertSrc,
                }),
                entryPoint: 'main',
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: 'Naive fragment shader',
                    code: shaders.naiveFragSrc,
                }),
                entryPoint: 'main',
                targets: [{ format: 'rgba16float' }],
            },
        });

        this.recreateDepthTexture();
        this.ensureSceneResources();
    }

    private ensureSceneResources(): void {
        this.lights.ensureClusterResources();
        const clusterBuffer = this.lights.clustersBuffer;
        if (this.boundClusterBuffer === clusterBuffer) {
            return;
        }

        this.boundClusterBuffer = clusterBuffer;
        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: 'Naive scene bind group',
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: clusterBuffer } },
            ],
        });
        this.geometryBundle = createGeometryBundle(
            this.scene,
            this.pipeline,
            this.sceneUniformsBindGroup,
            ['rgba16float'],
            depthFormat,
        );
    }

    private recreateDepthTexture(): void {
        this.depthTexture?.destroy();
        this.depthTexture = renderer.device.createTexture({
            label: 'Naive depth',
            size: [renderer.canvas.width, renderer.canvas.height],
            format: depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();
    }

    protected override draw(): void {
        this.ensureSceneResources();

        const encoder = renderer.device.createCommandEncoder({ label: 'Naive frame' });
        const renderPass = encoder.beginRenderPass({
            label: 'Naive geometry',
            timestampWrites: profiler.pass('Naive geometry'),
            colorAttachments: [{
                view: this.outputView,
                clearValue: [0, 0, 0, 1],
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        if (settings.bundles) {
            renderPass.executeBundles([this.geometryBundle!]);
        } else {
            renderPass.setPipeline(this.pipeline);
            renderPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            drawGeometry(renderPass, this.scene);
        }
        renderPass.end();

        this.finishFrame(encoder);
    }

    protected override onResize(): void {
        this.recreateDepthTexture();
    }

    protected override onDispose(): void {
        this.depthTexture.destroy();
        this.geometryBundle = undefined;
        this.boundClusterBuffer = undefined;
    }
}
