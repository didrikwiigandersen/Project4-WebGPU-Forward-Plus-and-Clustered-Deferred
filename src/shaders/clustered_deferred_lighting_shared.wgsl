@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterSet: ClusterSet;

struct DeferredUniforms {
    debugMode: u32,
    width: u32,
    height: u32,
    padding: u32,
}

@group(3) @binding(4) var<uniform> deferredUniforms: DeferredUniforms;

fn deferredClusterColor(clusterIndex: u32) -> vec3f {
    let value = f32(clusterIndex);
    return vec3f(0.2) + 0.8 * fract(vec3f(
        value * 0.1031 + 0.17,
        value * 0.11369 + 0.43,
        value * 0.13787 + 0.71,
    ));
}

fn deferredLightCountColor(lightCount: u32) -> vec3f {
    let capacity = max(f32(camera.clusterDims.w), 1.0);
    let amount = clamp(f32(lightCount) / capacity, 0.0, 1.0);
    return vec3f(
        clamp(3.0 * amount - 1.0, 0.0, 1.0),
        clamp(1.5 - abs(3.0 * amount - 1.5), 0.0, 1.0),
        clamp(1.0 - 3.0 * amount, 0.0, 1.0),
    );
}

fn deferredVisibleColor(
    pixelCenter: vec2f,
    hardwareDepth: f32,
    positionWorld: vec3f,
    normalValue: vec3f,
    albedo: vec4f,
) -> vec4f {
    let normalWorld = safeNormalize(normalValue);
    let clusterIndex = clusterIndexFromPixelDepth(camera, pixelCenter, hardwareDepth);

    if (deferredUniforms.debugMode == 1u || deferredUniforms.debugMode == 8u) {
        return vec4f(deferredClusterColor(clusterIndex), 1.0);
    }
    if (deferredUniforms.debugMode == 2u || deferredUniforms.debugMode == 3u) {
        let clusterCount = arrayLength(&clusterSet.clusters);
        if (clusterCount == 0u) {
            return vec4f(0.0, 0.0, 0.0, 1.0);
        }
        let safeClusterIndex = min(clusterIndex, clusterCount - 1u);
        if (deferredUniforms.debugMode == 2u) {
            let lightCount = clusterSet.clusters[safeClusterIndex].count;
            return vec4f(deferredLightCountColor(lightCount), 1.0);
        }
        let overflow = clusterSet.clusters[safeClusterIndex].overflow;
        let color = select(vec3f(0.0, 0.12, 0.0), vec3f(1.0, 0.0, 0.0), overflow != 0u);
        return vec4f(color, 1.0);
    }
    if (deferredUniforms.debugMode == 4u) {
        return vec4f(albedo.rgb, 1.0);
    }
    if (deferredUniforms.debugMode == 5u) {
        return vec4f(normalWorld * 0.5 + vec3f(0.5), 1.0);
    }
    if (deferredUniforms.debugMode == 6u) {
        return vec4f(vec3f(hardwareDepth), 1.0);
    }

    let illumination = shadeCluster(&lightSet, &clusterSet, clusterIndex, positionWorld, normalWorld);
    return vec4f(albedo.rgb * illumination, 1.0);
}
