import type { Renderer } from './renderer';
import type { Camera } from './stage/camera';
import type { Lights } from './stage/lights';
import type { settings } from './settings';

export type Configuration = Partial<typeof settings> & { lightCount?: number; width?: number; height?: number; resolution?: string; cameraPreset?: string };
export interface ProjectApp {
    readonly renderer: Renderer;
    readonly resolution: string;
    readonly cameraPreset: string;
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
export async function saveEvidence(
    name: string,
    data: Blob | string,
    mime = 'application/json',
    allowDownloadFallback = true,
): Promise<boolean> {
    const body = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
    const hostname = typeof window === 'undefined' ? '' : window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        try {
            const response = await fetch(`/__evidence?name=${encodeURIComponent(name)}`, {
                method: 'POST',
                body,
            });
            if (response.ok) return true;
        } catch {
            // A local server is optional. Fall through to a browser download.
        }
    }

    if (!allowDownloadFallback) return false;

    const parts = name.split('/');
    const link = document.createElement('a');
    const objectURL = URL.createObjectURL(body);
    link.href = objectURL;
    link.download = parts[parts.length - 1];
    try {
        link.click();
    } catch (error) {
        console.error('Evidence download could not be started', error);
    } finally {
        const revoke = () => {
            try {
                URL.revokeObjectURL(objectURL);
            } catch (error) {
                console.error('Evidence object URL could not be revoked', error);
            }
        };
        try {
            setTimeout(revoke, 1000);
        } catch {
            revoke();
        }
    }
    return false;
}
