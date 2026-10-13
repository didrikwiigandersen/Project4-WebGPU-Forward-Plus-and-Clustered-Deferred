import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const evidenceNamePattern = /^(performance|media)\/[a-zA-Z0-9_.-]+\.(json|csv|png|webm)$/
const maxEvidenceBytes = 512 * 1024 * 1024

function installEvidenceMiddleware(server: ViteDevServer | PreviewServer): void {
    server.middlewares.use('/__evidence', async (req, res) => {
        if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Allow', 'POST')
            res.end('POST required')
            return
        }

        const name = new URL(req.url || '/', 'http://localhost').searchParams.get('name') || ''
        if (!evidenceNamePattern.test(name)) {
            res.statusCode = 400
            res.end('Invalid evidence filename')
            return
        }

        const docsRoot = resolve('docs')
        const destination = resolve(docsRoot, name)
        const relativeDestination = relative(docsRoot, destination)
        if (
            relativeDestination === '..'
            || relativeDestination.startsWith('..' + sep)
            || isAbsolute(relativeDestination)
        ) {
            res.statusCode = 400
            res.end('Invalid evidence path')
            return
        }

        const contentLengthValue = Array.isArray(req.headers['content-length'])
            ? req.headers['content-length'][0]
            : req.headers['content-length']
        const contentLength = contentLengthValue === undefined
            ? undefined
            : Number(contentLengthValue)
        if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxEvidenceBytes) {
            res.statusCode = 413
            res.end('Evidence exceeds 512 MiB limit')
            return
        }

        try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of req) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                size += bytes.byteLength
                if (size > maxEvidenceBytes) {
                    res.statusCode = 413
                    res.end('Evidence exceeds 512 MiB limit')
                    return
                }
                chunks.push(bytes)
            }

            await mkdir(dirname(destination), { recursive: true })
            await writeFile(destination, Buffer.concat(chunks, size))
            res.statusCode = 200
            res.end('Saved')
        } catch (error) {
            if (!res.writableEnded) {
                res.statusCode = 500
                res.end(String(error))
            }
        }
    })
}

const localEvidencePlugin: Plugin = {
    name: 'local-evidence',
    configureServer(server) {
        installEvidenceMiddleware(server)
    },
    configurePreviewServer(server) {
        installEvidenceMiddleware(server)
    },
}

export default defineConfig({
    plugins: [localEvidencePlugin],
    build: {
        target: 'esnext'
    },
    base: process.env.GITHUB_ACTIONS_BASE ? `/${process.env.GITHUB_ACTIONS_BASE.replace(/^\/+|\/+$/g, '')}/` : undefined
})
