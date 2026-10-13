import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, createServer } from 'vite';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaderModulePath = resolve(projectRoot, 'src/shaders/shaders.ts');
const shaderSourceNames = [
    'naiveVertSrc',
    'naiveFragSrc',
    'forwardPlusFragSrc',
    'forwardPlusPrepassFragSrc',
    'forwardPlusMarkerVertSrc',
    'forwardPlusMarkerFragSrc',
    'clusteredDeferredFragSrc',
    'clusteredDeferredCompactFragSrc',
    'clusteredDeferredFullscreenVertSrc',
    'clusteredDeferredFullscreenFragSrc',
    'clusteredDeferredComputeSrc',
    'clusteredDeferredCompactComputeSrc',
    'clusteredDeferredCompactFullscreenFragSrc',
    'moveLightsComputeSrc',
    'viewLightsComputeSrc',
    'clusterBoundsComputeSrc',
    'clusteringComputeSrc',
    'maskedClusteringComputeSrc',
];
const allConstantsProbe = [
    '${bindGroup_scene}',
    '${bindGroup_model}',
    '${bindGroup_material}',
    '${moveLightsWorkgroupSize}',
    '${lightRadius}',
    '${clusterCapacity}',
].join(',');
const unknownConstantProbe = 'const invalid = ${notAConstant};\n';
const malformedConstantProbe = 'const invalid = ${lightRadius;\n';

async function loadDevelopmentShaders() {
    const server = await createServer({
        root: projectRoot,
        configFile: false,
        appType: 'custom',
        logLevel: 'silent',
        server: { middlewareMode: true },
    });
    try {
        return await server.ssrLoadModule('/src/shaders/shaders.ts');
    } finally {
        await server.close();
    }
}

async function loadMinifiedProductionShaders() {
    const virtualId = 'virtual:shader-production-regression';
    const resolvedVirtualId = `\0${virtualId}`;
    const shaderEntries = shaderSourceNames
        .map(name => `${JSON.stringify(name)}: shaders.${name}`)
        .join(',\n');
    const entrySource = `
        import * as shaders from ${JSON.stringify(shaderModulePath)};

        // Match the constants read directly by application host code. In
        // particular, lightRadius is deliberately only reached through WGSL
        // interpolation, reproducing the production tree-shaking boundary.
        export const hostConstants = [
            shaders.constants.bindGroup_scene,
            shaders.constants.bindGroup_model,
            shaders.constants.bindGroup_material,
            shaders.constants.moveLightsWorkgroupSize,
            shaders.constants.clusterCapacity,
        ];
        export const shaderSources = {
            ${shaderEntries}
        };
        export const allConstantsProbe = shaders.processShaderRaw(${JSON.stringify(allConstantsProbe)});
        function interpolationError(raw) {
            try {
                shaders.processShaderRaw(raw);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        }
        export const unknownConstantError = interpolationError(${JSON.stringify(unknownConstantProbe)});
        export const malformedConstantError = interpolationError(${JSON.stringify(malformedConstantProbe)});
    `;

    const result = await build({
        root: projectRoot,
        configFile: false,
        logLevel: 'silent',
        plugins: [{
            name: 'shader-production-regression',
            resolveId(id) {
                if (id === virtualId) return resolvedVirtualId;
            },
            load(id) {
                if (id === resolvedVirtualId) return entrySource;
            },
        }],
        build: {
            write: false,
            target: 'esnext',
            minify: 'esbuild',
            rollupOptions: {
                input: virtualId,
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    entryFileNames: 'shader-production-regression.mjs',
                },
            },
        },
    });

    const rollupOutput = Array.isArray(result) ? result[0] : result;
    const entryChunk = rollupOutput.output.find(output => output.type === 'chunk' && output.isEntry);
    assert.ok(entryChunk, 'Vite did not emit the shader regression entry chunk');
    assert.deepEqual(entryChunk.imports, []);
    assert.deepEqual(entryChunk.dynamicImports, []);

    const encoded = Buffer.from(entryChunk.code).toString('base64');
    return import(`data:text/javascript;base64,${encoded}`);
}

test('minified production shaders exactly match development shader bytes', async () => {
    const development = await loadDevelopmentShaders();
    const production = await loadMinifiedProductionShaders();
    const developmentShaderNames = Object.entries(development)
        .filter(([name, value]) => name.endsWith('Src') && typeof value === 'string')
        .map(([name]) => name)
        .sort();

    assert.deepEqual(developmentShaderNames, [...shaderSourceNames].sort());
    assert.deepEqual(production.hostConstants, [0, 1, 2, 128, 1024]);

    for (const name of shaderSourceNames) {
        assert.ok(
            production.shaderSources[name] === development[name],
            `${name} differs after minification (${Buffer.byteLength(development[name])} development bytes, `
                + `${Buffer.byteLength(production.shaderSources[name])} production bytes)`,
        );
        assert.equal(production.shaderSources[name].includes('${'), false, `${name} has an unresolved placeholder`);
        assert.equal(production.shaderSources[name].includes('undefined'), false, `${name} contains undefined`);
        assert.ok(production.shaderSources[name].includes('safeDistance / 2'), `${name} lost lightRadius`);
        assert.ok(production.shaderSources[name].includes('f32(2) * f32(2)'), `${name} lost lightRadius`);
    }
    assert.ok(
        production.shaderSources.clusteringComputeSrc.includes('let radius = f32(2);'),
        'clusteringComputeSrc lost lightRadius',
    );

    const developmentProbe = development.processShaderRaw(allConstantsProbe);
    const productionProbe = production.allConstantsProbe;
    assert.equal(productionProbe, developmentProbe);
    assert.equal(productionProbe.endsWith('0,1,2,128,2,1024'), true);

    assert.throws(
        () => development.processShaderRaw(unknownConstantProbe),
        /Unknown shader constant placeholder: \$\{notAConstant\}/,
    );
    assert.throws(
        () => development.processShaderRaw(malformedConstantProbe),
        /Malformed shader constant placeholder/,
    );
    assert.match(production.unknownConstantError, /Unknown shader constant placeholder: \$\{notAConstant\}/);
    assert.match(production.malformedConstantError, /Malformed shader constant placeholder/);
});
