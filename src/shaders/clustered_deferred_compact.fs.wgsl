@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
}

@fragment
fn main(in: FragmentInput) -> @location(0) vec4u {
    let albedo = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (albedo.a < 0.5) {
        discard;
    }
    return packCompactGBuffer(albedo, safeNormalize(in.nor));
}
