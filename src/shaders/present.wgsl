struct Params { threshold: f32, strength: f32, debugBloom: f32, padding: f32 }
@group(0) @binding(0) var lighting: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: Params;

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(positions[index], 0, 1);
}

@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let size = vec2f(textureDimensions(lighting));
    let blurred = textureSampleLevel(bloom, linearSampler, position.xy / size, 0).rgb;
    let base = textureLoad(lighting, vec2i(position.xy), 0).rgb;
    let color = select(base + params.strength * blurred, blurred, params.debugBloom > 0.5);
    return vec4f(clamp(color, vec3f(0), vec3f(1)), 1);
}
