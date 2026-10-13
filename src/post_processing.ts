import { canvasFormat, context, device } from './renderer';
import { profiler } from './profiler';
import { settings } from './settings';
import extractSource from './shaders/bloom_extract.cs.wgsl?raw';
import blurSource from './shaders/bloom_blur.cs.wgsl?raw';
import presentSource from './shaders/present.wgsl?raw';

export class PostProcessing {
    private readonly computeLayout: GPUBindGroupLayout;
    private readonly presentLayout: GPUBindGroupLayout;
    private readonly extractPipeline: GPUComputePipeline;
    private readonly blurPipeline: GPUComputePipeline;
    private readonly presentPipeline: GPURenderPipeline;
    private readonly params: GPUBuffer;
    private readonly horizontalParams: GPUBuffer;
    private readonly verticalParams: GPUBuffer;
    private readonly sampler: GPUSampler;
    private textures: GPUTexture[] = [];
    private horizontalGroup!: GPUBindGroup;
    private verticalGroup!: GPUBindGroup;
    private extractGroup?: GPUBindGroup;
    private presentGroup?: GPUBindGroup;
    private source?: GPUTexture;
    private width = 1;
    private height = 1;

    constructor(width: number, height: number) {
        this.computeLayout = device.createBindGroupLayout({ label: 'Bloom compute layout', entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ] });
        this.presentLayout = device.createBindGroupLayout({ label: 'Presentation layout', entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ] });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this.computeLayout] });
        this.extractPipeline = device.createComputePipeline({ label: 'Bloom extraction', layout, compute: { module: device.createShaderModule({ label: 'Bloom extraction shader', code: extractSource }), entryPoint: 'main' } });
        this.blurPipeline = device.createComputePipeline({ label: 'Gaussian bloom blur', layout, compute: { module: device.createShaderModule({ label: 'Gaussian blur shader', code: blurSource }), entryPoint: 'main' } });
        const module = device.createShaderModule({ label: 'Presentation shader', code: presentSource });
        this.presentPipeline = device.createRenderPipeline({ label: 'HDR presentation', layout: device.createPipelineLayout({ bindGroupLayouts: [this.presentLayout] }), vertex: { module, entryPoint: 'vertexMain' }, fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: canvasFormat }] } });
        const makeUniform = (label: string) => device.createBuffer({ label, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.params = makeUniform('Bloom settings');
        this.horizontalParams = makeUniform('Horizontal blur direction');
        this.verticalParams = makeUniform('Vertical blur direction');
        device.queue.writeBuffer(this.horizontalParams, 0, new Int32Array([1, 0, 0, 0]));
        device.queue.writeBuffer(this.verticalParams, 0, new Int32Array([0, 1, 0, 0]));
        this.sampler = device.createSampler({ label: 'Bloom upsampling', minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        this.resize(width, height);
    }

    resize(width: number, height: number) {
        this.textures.forEach(t => t.destroy());
        this.width = Math.max(1, Math.ceil(width / 2));
        this.height = Math.max(1, Math.ceil(height / 2));
        this.textures = ['Bright pixels', 'Horizontal bloom', 'Gaussian bloom'].map(label => device.createTexture({ label, size: [this.width, this.height], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }));
        const group = (input: GPUTexture, output: GPUTexture, params: GPUBuffer) => device.createBindGroup({ layout: this.computeLayout, entries: [
            { binding: 0, resource: input.createView() }, { binding: 1, resource: output.createView() }, { binding: 2, resource: { buffer: params } },
        ] });
        this.horizontalGroup = group(this.textures[0], this.textures[1], this.horizontalParams);
        this.verticalGroup = group(this.textures[1], this.textures[2], this.verticalParams);
        this.source = undefined;
        this.extractGroup = undefined;
        this.presentGroup = undefined;
    }

    private bindSource(input: GPUTexture) {
        if (this.source === input) return;
        this.source = input;
        this.extractGroup = device.createBindGroup({ label: 'Bloom extraction inputs', layout: this.computeLayout, entries: [
            { binding: 0, resource: input.createView() }, { binding: 1, resource: this.textures[0].createView() }, { binding: 2, resource: { buffer: this.params } },
        ] });
        this.presentGroup = device.createBindGroup({ label: 'Presentation inputs', layout: this.presentLayout, entries: [
            { binding: 0, resource: input.createView() }, { binding: 1, resource: this.textures[2].createView() }, { binding: 2, resource: this.sampler }, { binding: 3, resource: { buffer: this.params } },
        ] });
    }

    render(encoder: GPUCommandEncoder, input: GPUTexture) {
        this.bindSource(input);
        const debugBloom = settings.debugView === 'bloom';
        const enabled = settings.bloom || debugBloom;
        device.queue.writeBuffer(this.params, 0, new Float32Array([settings.bloomThreshold, enabled ? settings.bloomStrength : 0, debugBloom ? 1 : 0, 0]));
        if (enabled) {
            for (const [label, pipeline, group] of [
                ['Bloom extraction', this.extractPipeline, this.extractGroup!],
                ['Bloom horizontal', this.blurPipeline, this.horizontalGroup],
                ['Bloom vertical', this.blurPipeline, this.verticalGroup],
            ] as const) {
                const pass = encoder.beginComputePass({ label, timestampWrites: profiler.pass(label) });
                pass.setPipeline(pipeline); pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
                pass.end();
            }
        }
        const pass = encoder.beginRenderPass({ label: 'Presentation', timestampWrites: profiler.pass('Presentation'), colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(this.presentPipeline); pass.setBindGroup(0, this.presentGroup!); pass.draw(3); pass.end();
    }

    get bloomTexture(): GPUTexture { return this.textures[2]; }

    dispose() {
        this.textures.forEach(t => t.destroy());
        this.params.destroy(); this.horizontalParams.destroy(); this.verticalParams.destroy();
    }
}
