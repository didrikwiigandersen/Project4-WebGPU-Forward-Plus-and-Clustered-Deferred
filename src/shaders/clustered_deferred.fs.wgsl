@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
}

struct GBufferOutput {
    @location(0) position: vec4f,
    @location(1) normal: vec4f,
    @location(2) albedo: vec4f,
}

@fragment
fn main(in: FragmentInput) -> GBufferOutput {
    let albedo = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (albedo.a < 0.5) {
        discard;
    }

    var out: GBufferOutput;
    out.position = vec4f(in.pos, 1.0);
    out.normal = vec4f(safeNormalize(in.nor), 0.0);
    out.albedo = albedo;
    return out;
}
