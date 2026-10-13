// CHECKITOUT: this file loads all the shaders and preprocesses them with some common code

import commonRaw from './common.wgsl?raw';

import naiveVertRaw from './naive.vs.wgsl?raw';
import naiveFragRaw from './naive.fs.wgsl?raw';

import forwardPlusFragRaw from './forward_plus.fs.wgsl?raw';
import forwardPlusPrepassFragRaw from './forward_plus_prepass.fs.wgsl?raw';
import forwardPlusMarkerVertRaw from './forward_plus_marker.vs.wgsl?raw';
import forwardPlusMarkerFragRaw from './forward_plus_marker.fs.wgsl?raw';

import clusteredDeferredFragRaw from './clustered_deferred.fs.wgsl?raw';
import clusteredDeferredCompactFragRaw from './clustered_deferred_compact.fs.wgsl?raw';
import clusteredDeferredFullscreenVertRaw from './clustered_deferred_fullscreen.vs.wgsl?raw';
import clusteredDeferredFullscreenFragRaw from './clustered_deferred_fullscreen.fs.wgsl?raw';
import clusteredDeferredLightingSharedRaw from './clustered_deferred_lighting_shared.wgsl?raw';
import clusteredDeferredComputeRaw from './clustered_deferred_compute.cs.wgsl?raw';
import clusteredDeferredCompactComputeRaw from './clustered_deferred_compact_compute.cs.wgsl?raw';
import clusteredDeferredCompactFullscreenFragRaw from './clustered_deferred_compact_fullscreen.fs.wgsl?raw';

import moveLightsComputeRaw from './move_lights.cs.wgsl?raw';
import viewLightsComputeRaw from './transform_lights.cs.wgsl?raw';
import clusterBoundsComputeRaw from './cluster_bounds.cs.wgsl?raw';
import clusteringComputeRaw from './clustering.cs.wgsl?raw';

// CONSTANTS (for use in shaders)
// =================================

// CHECKITOUT: feel free to add more constants here and to refer to them in your shader code

// Keep shader constants in one table so host code and WGSL interpolation use
// the same values. The indexed lookup below also keeps every property visible
// to production tree-shaking.
export const constants = {
    bindGroup_scene: 0,
    bindGroup_model: 1,
    bindGroup_material: 2,

    moveLightsWorkgroupSize: 128,

    lightRadius: 2,
    clusterCapacity: 1024,
};

// =================================

function interpolateShaderRaw(raw: string): string {
    const interpolated = raw.replace(/\$\{([^{}]*)\}/g, (placeholder, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(constants, name)) {
            throw new Error(`Unknown shader constant placeholder: ${placeholder}`);
        }
        return String(constants[name as keyof typeof constants]);
    });

    if (interpolated.includes('${')) {
        throw new Error('Malformed shader constant placeholder');
    }
    return interpolated;
}

const commonSrc: string = interpolateShaderRaw(commonRaw);

export function processShaderRaw(raw: string): string {
    return commonSrc + interpolateShaderRaw(raw);
}

export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);

export const forwardPlusFragSrc: string = processShaderRaw(forwardPlusFragRaw);
export const forwardPlusPrepassFragSrc: string = processShaderRaw(forwardPlusPrepassFragRaw);
export const forwardPlusMarkerVertSrc: string = processShaderRaw(forwardPlusMarkerVertRaw);
export const forwardPlusMarkerFragSrc: string = processShaderRaw(forwardPlusMarkerFragRaw);

export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredCompactFragSrc: string = processShaderRaw(clusteredDeferredCompactFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(clusteredDeferredFullscreenFragRaw);
export const clusteredDeferredComputeSrc: string = processShaderRaw(
    clusteredDeferredLightingSharedRaw + '\n' + clusteredDeferredComputeRaw,
);
export const clusteredDeferredCompactComputeSrc: string = processShaderRaw(
    clusteredDeferredLightingSharedRaw + '\n' + clusteredDeferredCompactComputeRaw,
);
export const clusteredDeferredCompactFullscreenFragSrc: string = processShaderRaw(
    clusteredDeferredLightingSharedRaw + '\n' + clusteredDeferredCompactFullscreenFragRaw,
);

export const moveLightsComputeSrc: string = processShaderRaw(moveLightsComputeRaw);
export const viewLightsComputeSrc: string = processShaderRaw(viewLightsComputeRaw);
export const clusterBoundsComputeSrc: string = processShaderRaw(clusterBoundsComputeRaw);
export const clusteringComputeSrc: string = processShaderRaw(clusteringComputeRaw);
export const maskedClusteringComputeSrc: string = clusteringComputeSrc;
