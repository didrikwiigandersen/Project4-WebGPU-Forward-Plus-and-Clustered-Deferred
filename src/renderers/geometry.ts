import { device } from '../renderer';
import { Scene } from '../stage/scene';
import { constants } from '../shaders/shaders';

/**
 * Encode the scene's geometry into either a render pass or a render bundle.
 *
 * Scene.iterate groups primitives by node and material, so keeping the binding
 * changes in its callbacks avoids redundant model/material bindings while
 * preserving the loader's draw order.
 */
export function drawGeometry(
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    scene: Scene,
): void {
    scene.iterate(node => {
        pass.setBindGroup(constants.bindGroup_model, node.modelBindGroup);
    }, material => {
        pass.setBindGroup(constants.bindGroup_material, material.materialBindGroup);
    }, primitive => {
        pass.setVertexBuffer(0, primitive.vertexBuffer);
        pass.setIndexBuffer(primitive.indexBuffer, 'uint32');
        pass.drawIndexed(primitive.numIndices);
    });
}

/**
 * Record the immutable geometry portion of a render pass. Callers own the
 * resulting bundle and cache it for as long as the pipeline and scene bind
 * group remain compatible.
 */
export function createGeometryBundle(
    scene: Scene,
    pipeline: GPURenderPipeline,
    sceneBindGroup: GPUBindGroup,
    colorFormats: GPUTextureFormat[],
    depthStencilFormat: GPUTextureFormat,
    depthReadOnly = false,
): GPURenderBundle {
    const encoder = device.createRenderBundleEncoder({
        label: 'Scene geometry bundle encoder',
        colorFormats,
        depthStencilFormat,
        depthReadOnly,
    });

    encoder.setPipeline(pipeline);
    encoder.setBindGroup(constants.bindGroup_scene, sceneBindGroup);
    drawGeometry(encoder, scene);

    return encoder.finish({ label: 'Scene geometry bundle' });
}
