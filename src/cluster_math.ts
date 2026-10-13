export type Dimensions = [number, number, number];
export function flatten(x: number, y: number, z: number, dimensions: Dimensions): number {
    return x + dimensions[0] * (y + dimensions[1] * z);
}
export function unflatten(index: number, dimensions: Dimensions): Dimensions {
    const x = index % dimensions[0];
    const y = Math.floor(index / dimensions[0]) % dimensions[1];
    return [x, y, Math.floor(index / (dimensions[0] * dimensions[1]))];
}
export function sliceBoundary(index: number, slices: number, near: number, far: number): number {
    return near * (far / near) ** (index / slices);
}
export function sliceIndex(distance: number, slices: number, near: number, far: number): number {
    return Math.max(0, Math.min(slices - 1, Math.floor(slices * Math.log(Math.max(distance, near) / near) / Math.log(far / near))));
}
export function multiplyPoint(matrix: ArrayLike<number>, point: number[]): number[] {
    return [0, 1, 2, 3].map(row => matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12] * point[3]);
}
export function boundsForCluster(index: number, dimensions: Dimensions, inverseProjection: ArrayLike<number>, near: number, far: number): number[] {
    const [x, y, z] = unflatten(index, dimensions);
    const distances = [sliceBoundary(z, dimensions[2], near, far), sliceBoundary(z + 1, dimensions[2], near, far)];
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (const distance of distances) for (const cy of [y, y + 1]) for (const cx of [x, x + 1]) {
        const ray = multiplyPoint(inverseProjection, [2 * cx / dimensions[0] - 1, 1 - 2 * cy / dimensions[1], 1, 1]);
        const point = [ray[0] * distance / -ray[2], ray[1] * distance / -ray[2], -distance];
        for (let axis = 0; axis < 3; axis++) { minimum[axis] = Math.min(minimum[axis], point[axis]); maximum[axis] = Math.max(maximum[axis], point[axis]); }
    }
    const epsilon = Math.max(1e-4, distances[1] * 1e-3);
    return [...minimum.map(v => v - epsilon), ...maximum.map(v => v + epsilon)];
}
export function sphereIntersects(center: number[], radius: number, bounds: ArrayLike<number>): boolean {
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
        const closest = Math.max(bounds[axis], Math.min(bounds[axis + 3], center[axis]));
        squared += (center[axis] - closest) ** 2;
    }
    return squared <= radius * radius;
}
const signNotZero = (value: number) => value < 0 ? -1 : 1;
export function encodeOct(normal: number[]): number[] {
    const sum = normal.reduce((total, value) => total + Math.abs(value), 0);
    const x = normal[0] / sum, y = normal[1] / sum;
    return normal[2] < 0 ? [(1 - Math.abs(y)) * signNotZero(x), (1 - Math.abs(x)) * signNotZero(y)] : [x, y];
}
export function decodeOct(encoded: number[]): number[] {
    let [x, y] = encoded; const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) { const oldX = x; x = (1 - Math.abs(y)) * signNotZero(oldX); y = (1 - Math.abs(oldX)) * signNotZero(y); }
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
}
