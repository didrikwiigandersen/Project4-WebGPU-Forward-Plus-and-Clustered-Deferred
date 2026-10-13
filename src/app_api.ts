import type { Renderer } from './renderer';
import type { Camera } from './stage/camera';
import type { Lights } from './stage/lights';
import type { settings } from './settings';

export type Configuration = Partial<typeof settings> & { lightCount?: number; width?: number; height?: number; cameraPreset?: string };
export interface ProjectApp {
    readonly renderer: Renderer;
    readonly camera: Camera;
    readonly lights: Lights;
    readonly errors: string[];
    configure(configuration: Configuration): void;
    pause(): void;
    resume(): void;
    render(time?: number): void;
    setStatus(message: string): void;
}
export const cameraPresets: Record<string, { position: [number, number, number]; yaw: number; pitch: number }> = {
    Atrium: { position: [-7, 2, 0], yaw: 0, pitch: 0 },
    Arcade: { position: [-9, 1.3, -2.4], yaw: 8, pitch: 0 },
    Overview: { position: [-7, 5.8, 0], yaw: 0, pitch: -12 },
};
export async function saveEvidence(name: string, data: Blob | string, mime = 'application/json'): Promise<boolean> {
    const body = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
    if (import.meta.env.DEV) {
        const response = await fetch(`/__evidence?name=${encodeURIComponent(name)}`, { method: 'POST', body });
        if (response.ok) return true;
    }
    const link = document.createElement('a');
    const parts = name.split('/');
    link.href = URL.createObjectURL(body); link.download = parts[parts.length - 1];
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return false;
}
