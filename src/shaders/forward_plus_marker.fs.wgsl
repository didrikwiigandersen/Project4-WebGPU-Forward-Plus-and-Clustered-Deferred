@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var sceneDepth: texture_depth_2d;
@group(${bindGroup_scene}) @binding(2) var<storage, read_write> activeMask: array<atomic<u32>>;

@fragment
fn main(@builtin(position) fragCoord: vec4f) -> @location(0) f32 {
    let pixel = vec2i(fragCoord.xy);
    let hardwareDepth = textureLoad(sceneDepth, pixel, 0);

    if (hardwareDepth < 1.0) {
        let clusterIndex = clusterIndexFromPixelDepth(camera, fragCoord.xy, hardwareDepth);
        atomicStore(&activeMask[clusterIndex], 1u);
        return 1.0;
    }

    return 0.0;
}
