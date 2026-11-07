import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 128 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('The upload is too large. Choose an image under 15 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const request = new Request('http://localhost/api/edit', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body,
    duplex: 'half',
  });
  return request.formData();
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function editImage(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 503, { error: 'Image generation is not configured. Add OPENAI_API_KEY to the server environment and restart it.' });
    return;
  }
  if (!req.headers['content-type']?.startsWith('multipart/form-data;')) {
    sendJson(res, 400, { error: 'Send an image and edit prompt using the upload form.' });
    return;
  }

  try {
    const fields = await readForm(req);
    const image = fields.get('image');
    const prompt = fields.get('prompt');
    const adultConsent = fields.get('adultConsent');
    if (!(image instanceof File) || !image.size) {
      sendJson(res, 400, { error: 'Choose an image before generating an edit.' });
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) {
      sendJson(res, 400, { error: 'Use a JPG, PNG, or WEBP image.' });
      return;
    }
    if (image.size > MAX_IMAGE_BYTES) {
      sendJson(res, 413, { error: 'The image is larger than 15 MB. Choose a smaller file.' });
      return;
    }
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) {
      sendJson(res, 400, { error: 'Enter an edit prompt of up to 1000 characters.' });
      return;
    }
    if (adultConsent !== 'true') {
      sendJson(res, 400, { error: 'Confirm that the depicted person is an adult and you have permission to edit the image.' });
      return;
    }

    const upstreamForm = new FormData();
    upstreamForm.append('model', 'gpt-image-1');
    upstreamForm.append('image', image, image.name || 'image');
    upstreamForm.append('prompt', prompt.trim());
    upstreamForm.append('size', '1024x1024');
    upstreamForm.append('quality', 'medium');
    upstreamForm.append('output_format', 'png');

    const upstream = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: upstreamForm,
      signal: AbortSignal.timeout(180_000),
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = result.error?.message || 'The image service could not complete this edit.';
      const status = upstream.status === 429 ? 429 : upstream.status === 400 ? 422 : 502;
      sendJson(res, status, { error: message });
      return;
    }
    const encoded = result.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded) {
      sendJson(res, 502, { error: 'The image service returned no edited image. Please try again.' });
      return;
    }
    sendJson(res, 200, { image: `data:image/png;base64,${encoded}` });
  } catch (error) {
    if (res.headersSent) return;
    const status = error.status || (error.name === 'TimeoutError' ? 504 : 500);
    sendJson(res, status, { error: error.status ? error.message : 'Could not process the image. Please try again.' });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/edit') {
    void editImage(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD, POST' });
    res.end('Method not allowed');
    return;
  }

  if (url.pathname !== '/') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  let file = resolve(ROOT, 'index.html');
  try {
    if (statSync(file).isDirectory()) file = resolve(file, 'index.html');
    const info = statSync(file);
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Muse Edit is running at http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) console.log('Set OPENAI_API_KEY on the server to enable image edits.');
});
