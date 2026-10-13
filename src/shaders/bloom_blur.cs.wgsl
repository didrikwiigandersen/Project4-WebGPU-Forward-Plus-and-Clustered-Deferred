struct BlurParams { direction: vec2i, padding: vec2i }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: BlurParams;
const weights = array<f32, 5>(0.20416369, 0.18017382, 0.12383154, 0.06628225, 0.02763055);

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2i(textureDimensions(source));
    let pixel = vec2i(id.xy);
    if (any(pixel >= size)) { return; }
    var color = textureLoad(source, pixel, 0).rgb * weights[0];
    for (var tap = 1; tap <= 4; tap++) {
        let offset = params.direction * tap;
        color += textureLoad(source, clamp(pixel + offset, vec2i(0), size - 1), 0).rgb * weights[u32(tap)];
        color += textureLoad(source, clamp(pixel - offset, vec2i(0), size - 1), 0).rgb * weights[u32(tap)];
    }
    textureStore(destination, pixel, vec4f(min(color, vec3f(65504)), 1));
}
