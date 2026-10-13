import { defineConfig } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

export default defineConfig({
    plugins: [{
        name: 'local-evidence',
        configureServer(server) {
            server.middlewares.use('/__evidence', async (req, res) => {
                if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
                const name = new URL(req.url || '/', 'http://localhost').searchParams.get('name') || '';
                if (!/^(performance|media)\/[a-zA-Z0-9_.-]+\.(json|csv|png|webm)$/.test(name)) {
                    res.statusCode = 400; res.end('Invalid evidence filename'); return;
                }
                try {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 200 * 1024 * 1024) throw new Error('Evidence exceeds size limit');
                        chunks.push(chunk);
                    }
                    const path = resolve('docs', name);
                    await mkdir(dirname(path), { recursive: true });
                    await writeFile(path, Buffer.concat(chunks));
                    res.end('Saved');
                } catch (error) { res.statusCode = 500; res.end(String(error)); }
            });
        },
    }],
    build: {
        target: 'esnext'
    },
    base: process.env.GITHUB_ACTIONS_BASE || undefined
})
