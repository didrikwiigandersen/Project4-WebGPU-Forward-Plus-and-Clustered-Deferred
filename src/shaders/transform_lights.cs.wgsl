@group(0) @binding(0) var<storage, read> worldLightSet: LightSet;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<storage, read_write> viewLightPositions: array<vec4f>;

@compute
@workgroup_size(128)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let lightIndex = globalId.x;
    let availableLights = arrayLength(&worldLightSet.lights);
    let lightCount = min(worldLightSet.numLights, availableLights);
    if (lightIndex >= lightCount) {
        return;
    }

    viewLightPositions[lightIndex] = camera.viewMat
        * vec4f(worldLightSet.lights[lightIndex].pos, 1.0);
}
