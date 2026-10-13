import { Mat4, mat4, Vec3, vec3 } from "wgpu-matrix";
import { toRadians } from "../math_util";
import { device, canvas, fovYDegrees } from "../renderer";
import { constants as shaderConstants } from "../shaders/shaders";
import { clusterDimensions } from "../settings";

/**
 * CPU mirror of the CameraUniforms WGSL struct.
 *
 * Matrix columns and vec4 values are all naturally 16-byte aligned, giving the
 * buffer the following fixed layout:
 *
 *   0   viewProjMat
 *   64  viewMat
 *   128 invProjMat
 *   192 invViewProjMat
 *   256 viewport
 *   272 depth
 *   288 clusterDims
 */
export class CameraUniforms {
    static readonly byteLength = 304;

    readonly buffer = new ArrayBuffer(CameraUniforms.byteLength);
    private readonly floatView = new Float32Array(this.buffer);
    private readonly uintView = new Uint32Array(this.buffer);

    set viewProjMat(mat: Mat4) {
        this.floatView.set(mat, 0);
    }

    set viewMat(mat: Mat4) {
        this.floatView.set(mat, 16);
    }

    set invProjMat(mat: Mat4) {
        this.floatView.set(mat, 32);
    }

    set invViewProjMat(mat: Mat4) {
        this.floatView.set(mat, 48);
    }

    set viewport(value: readonly [number, number, number, number]) {
        this.floatView.set(value, 64);
    }

    set depth(value: readonly [number, number, number, number]) {
        this.floatView.set(value, 68);
    }

    set clusterDims(value: readonly [number, number, number, number]) {
        this.uintView.set(value, 72);
    }
}

export class Camera {
    readonly uniforms = new CameraUniforms();
    readonly uniformsBuffer: GPUBuffer;

    projMat: Mat4 = mat4.create();
    viewMat: Mat4 = mat4.create();
    invProjMat: Mat4 = mat4.create();
    invViewProjMat: Mat4 = mat4.create();

    cameraPos: Vec3 = vec3.create(-7, 2, 0);
    cameraFront: Vec3 = vec3.create(0, 0, -1);
    cameraUp: Vec3 = vec3.create(0, 1, 0);
    cameraRight: Vec3 = vec3.create(1, 0, 0);
    yaw = 0;
    pitch = 0;
    moveSpeed = 0.004;
    sensitivity = 0.15;

    static readonly nearPlane = 0.1;
    static readonly farPlane = 1000;

    keys: { [key: string]: boolean } = {};

    private viewportWidth = 1;
    private viewportHeight = 1;
    private disposed = false;
    private inputEnabledValue = true;

    get inputEnabled(): boolean {
        return this.inputEnabledValue;
    }

    set inputEnabled(enabled: boolean) {
        this.inputEnabledValue = enabled;
        if (!enabled) {
            this.keys = {};
            if (document.pointerLockElement === canvas) {
                document.exitPointerLock();
            }
        }
    }

    private readonly keyDownListener = (event: KeyboardEvent) => this.onKeyEvent(event, true);
    private readonly keyUpListener = (event: KeyboardEvent) => this.onKeyEvent(event, false);
    private readonly blurListener = () => {
        this.keys = {};
    };
    private readonly mouseDownListener = (event: MouseEvent) => {
        if (this.inputEnabledValue && event.button === 0) {
            void canvas.requestPointerLock();
        }
    };
    private readonly mouseUpListener = (event: MouseEvent) => {
        if (this.inputEnabledValue && event.button === 0 && document.pointerLockElement === canvas) {
            document.exitPointerLock();
        }
    };
    private readonly mouseMoveListener = (event: MouseEvent) => this.onMouseMove(event);

    constructor() {
        this.uniformsBuffer = device.createBuffer({
            label: "camera uniforms",
            size: this.uniforms.buffer.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.updateCameraVectors();

        window.addEventListener("keydown", this.keyDownListener);
        window.addEventListener("keyup", this.keyUpListener);
        window.addEventListener("blur", this.blurListener);
        canvas.addEventListener("mousedown", this.mouseDownListener);
        canvas.addEventListener("mouseup", this.mouseUpListener);
        canvas.addEventListener("mousemove", this.mouseMoveListener);

        // Populate and upload every field before any renderer can bind this camera.
        this.resize(canvas.width, canvas.height);
    }

    private static isEditableTarget(target: EventTarget | null): boolean {
        const element = target as HTMLElement | null;
        if (!element) {
            return false;
        }

        const tagName = element.tagName?.toLowerCase();
        return element.isContentEditable
            || tagName === "input"
            || tagName === "textarea"
            || tagName === "select";
    }

    private onKeyEvent(event: KeyboardEvent, down: boolean) {
        const key = event.key.toLowerCase();
        if (!this.inputEnabledValue) {
            if (!down) {
                this.keys[key] = false;
            }
            return;
        }

        if (Camera.isEditableTarget(event.target)) {
            // A key may have been pressed before an input received focus. Always
            // accept its release so movement cannot remain latched on.
            if (!down) {
                this.keys[key] = false;
            }
            return;
        }

        this.keys[key] = down;
        if (key === "alt" || this.keys["alt"]) {
            // Prevent browser menu shortcuts from stealing a movement key-up.
            event.preventDefault();
        }
    }

    private updateCameraVectors() {
        const yawRadians = toRadians(this.yaw);
        const pitchRadians = toRadians(this.pitch);
        const cosPitch = Math.cos(pitchRadians);

        this.cameraFront = vec3.normalize(vec3.create(
            Math.cos(yawRadians) * cosPitch,
            Math.sin(pitchRadians),
            Math.sin(yawRadians) * cosPitch,
        ));
        this.cameraRight = vec3.normalize(vec3.cross(this.cameraFront, [0, 1, 0]));
        this.cameraUp = vec3.normalize(vec3.cross(this.cameraRight, this.cameraFront));
    }

    private rotateCamera(dx: number, dy: number) {
        this.yaw += dx;
        this.pitch = Math.max(-89, Math.min(89, this.pitch - dy));
        this.updateCameraVectors();
    }

    private onMouseMove(event: MouseEvent) {
        if (this.inputEnabledValue && document.pointerLockElement === canvas) {
            this.rotateCamera(event.movementX * this.sensitivity, event.movementY * this.sensitivity);
        }
    }

    private processInput(deltaTime: number) {
        if (!this.inputEnabledValue || Camera.isEditableTarget(document.activeElement)) {
            return;
        }

        let moveDir = vec3.create(0, 0, 0);
        if (this.keys["w"]) {
            moveDir = vec3.add(moveDir, this.cameraFront);
        }
        if (this.keys["s"]) {
            moveDir = vec3.sub(moveDir, this.cameraFront);
        }
        if (this.keys["a"]) {
            moveDir = vec3.sub(moveDir, this.cameraRight);
        }
        if (this.keys["d"]) {
            moveDir = vec3.add(moveDir, this.cameraRight);
        }
        if (this.keys["q"]) {
            moveDir = vec3.sub(moveDir, this.cameraUp);
        }
        if (this.keys["e"]) {
            moveDir = vec3.add(moveDir, this.cameraUp);
        }

        let moveSpeed = this.moveSpeed * Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0);
        const moveSpeedMultiplier = 3;
        if (this.keys["shift"]) {
            moveSpeed *= moveSpeedMultiplier;
        }
        if (this.keys["alt"]) {
            moveSpeed /= moveSpeedMultiplier;
        }

        if (vec3.length(moveDir) > 0) {
            const moveAmount = vec3.scale(vec3.normalize(moveDir), moveSpeed);
            this.cameraPos = vec3.add(this.cameraPos, moveAmount);
        }
    }

    private updateUniforms() {
        const lookPos = vec3.add(this.cameraPos, this.cameraFront);
        this.viewMat = mat4.lookAt(this.cameraPos, lookPos, [0, 1, 0]);
        const viewProjMat = mat4.mul(this.projMat, this.viewMat);
        this.invViewProjMat = mat4.inverse(viewProjMat);

        const [clusterX, clusterY, clusterZ] = clusterDimensions();
        const logScale = clusterZ / Math.log(Camera.farPlane / Camera.nearPlane);
        const logBias = -Math.log(Camera.nearPlane) * logScale;

        this.uniforms.viewProjMat = viewProjMat;
        this.uniforms.viewMat = this.viewMat;
        this.uniforms.invProjMat = this.invProjMat;
        this.uniforms.invViewProjMat = this.invViewProjMat;
        this.uniforms.viewport = [
            this.viewportWidth,
            this.viewportHeight,
            1 / this.viewportWidth,
            1 / this.viewportHeight,
        ];
        this.uniforms.depth = [Camera.nearPlane, Camera.farPlane, logScale, logBias];
        this.uniforms.clusterDims = [clusterX, clusterY, clusterZ, shaderConstants.clusterCapacity];

        device.queue.writeBuffer(this.uniformsBuffer, 0, this.uniforms.buffer);
    }

    resize(width: number = canvas.width, height: number = canvas.height) {
        this.viewportWidth = Math.max(1, Math.floor(width));
        this.viewportHeight = Math.max(1, Math.floor(height));
        this.projMat = mat4.perspective(
            toRadians(fovYDegrees),
            this.viewportWidth / this.viewportHeight,
            Camera.nearPlane,
            Camera.farPlane,
        );
        this.invProjMat = mat4.inverse(this.projMat);
        this.updateUniforms();
    }

    setPose(position: [number, number, number], yaw: number, pitch: number) {
        this.cameraPos = vec3.create(position[0], position[1], position[2]);
        this.yaw = yaw;
        this.pitch = Math.max(-89, Math.min(89, pitch));
        this.updateCameraVectors();
        this.updateUniforms();
    }

    onFrame(deltaTime: number) {
        this.processInput(deltaTime);
        // updateUniforms intentionally re-reads clusterDimensions every frame so
        // a GUI grid change reaches all shader stages without recreating Camera.
        this.updateUniforms();
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        window.removeEventListener("keydown", this.keyDownListener);
        window.removeEventListener("keyup", this.keyUpListener);
        window.removeEventListener("blur", this.blurListener);
        canvas.removeEventListener("mousedown", this.mouseDownListener);
        canvas.removeEventListener("mouseup", this.mouseUpListener);
        canvas.removeEventListener("mousemove", this.mouseMoveListener);
        this.keys = {};
        this.uniformsBuffer.destroy();
    }
}
