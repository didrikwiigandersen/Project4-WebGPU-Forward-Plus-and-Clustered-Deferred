export const settings = {
    mode: 'clustered deferred',
    bundles: true,
    optimizedLightMath: true,
    depthMode: 'culling' as 'off' | 'prepass' | 'culling',
    deferredCompute: true,
    compactGBuffer: true,
    bloom: false,
    bloomThreshold: 1,
    bloomStrength: 0.2,
    debugView: 'none',
    clusterGrid: '16x9x24',
    freezeLights: false,
    fixedTime: 1000,
};

export function clusterDimensions(): [number, number, number] {
    const values = settings.clusterGrid.split('x').map(Number);
    if (values.length !== 3 || values.some(n => !Number.isInteger(n) || n < 1)) {
        throw new Error('Invalid cluster grid');
    }
    return [values[0], values[1], values[2]];
}

export const debugViews = ['none', 'clusters', 'light-count', 'overflow', 'albedo', 'normals', 'depth', 'bloom', 'active-clusters'];
