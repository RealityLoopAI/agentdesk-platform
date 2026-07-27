import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HASHED_ASSET = /^assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const SPA_ROUTE = /^\/(?:|login|conversations(?:\/[^/]+)?)$/;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function requestedFile(pathname: string): { relativePath: string; isHtml: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (SPA_ROUTE.test(decoded) || decoded === '/index.html') {
    return { relativePath: 'index.html', isHtml: true };
  }
  if (!decoded.startsWith('/assets/') && !decoded.startsWith('/brand/')) return null;
  const relativePath = decoded.slice(1);
  if (
    relativePath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
  ) {
    return null;
  }
  return { relativePath, isHtml: false };
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export interface WebStaticFiles {
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
}

export function createWebStaticFiles(staticDir = path.resolve(process.cwd(), 'web', 'dist')): WebStaticFiles {
  const configuredRoot = path.resolve(staticDir);
  let realRootPromise: Promise<string | null> | null = null;
  const realRoot = () => {
    realRootPromise ??= fs.realpath(configuredRoot).catch(() => null);
    return realRootPromise;
  };

  return {
    async serve(req, res, pathname) {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') return false;
      const requested = requestedFile(pathname);
      if (!requested) return false;
      const root = await realRoot();
      if (!root) return false;

      const unresolved = path.resolve(root, requested.relativePath);
      if (!withinRoot(root, unresolved)) return false;
      const candidate = await fs.realpath(unresolved).catch(() => null);
      if (!candidate || !withinRoot(root, candidate)) return false;
      const extension = path.extname(candidate).toLowerCase();
      const contentType = CONTENT_TYPES[extension];
      if (!contentType) return false;
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile()) return false;

      const body = method === 'HEAD' ? null : await fs.readFile(candidate).catch(() => null);
      if (method !== 'HEAD' && !body) return false;
      res.statusCode = 200;
      res.setHeader('content-type', contentType);
      res.setHeader('content-length', String(stat.size));
      if (requested.isHtml) {
        res.setHeader('cache-control', 'no-cache');
      } else if (HASHED_ASSET.test(requested.relativePath)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('cache-control', 'public, max-age=3600');
      }
      if (body) res.end(body);
      else res.end();
      return true;
    },
  };
}
