struct Params { threshold: f32, strength: f32, debugBloom: f32, padding: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(destination);
    if (any(id.xy >= size)) { return; }
    let sourceSize = vec2i(textureDimensions(source));
    let origin = vec2i(id.xy) * 2;
    var color = vec3f(0);
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            color += textureLoad(source, min(origin + vec2i(x, y), sourceSize - 1), 0).rgb;
        }
    }
    color *= 0.25;
    let brightness = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let amount = max(brightness - params.threshold, 0.0) / max(brightness, 0.0001);
    textureStore(destination, vec2i(id.xy), vec4f(min(color * amount, vec3f(65504)), 1));
}
