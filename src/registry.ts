// The npm registry adapter: tarballs fetched by code, from registry.npmjs.org only, with no credentials.
import { onRegistry } from './dependencies.ts';
import { FetchError, type RegistryPort } from './ports.ts';

export function npmRegistry(): RegistryPort {
  return {
    async tarball(url, maxBytes, signal) {
      // Checked here too, so no caller can point a fetch elsewhere; no redirect may either.
      if (!onRegistry(url) || new URL(url).origin !== 'https://registry.npmjs.org') throw new Error('refused: not on the npm registry');
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
      if (!res.ok || !res.body) throw new Error(`registry: ${res.status}`);
      // Counted as it arrives: a Content-Length can be missing or lie.
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > maxBytes) throw new Error(`over the run's remaining ${maxBytes} bytes`);
          chunks.push(chunk);
        }
      } catch (err) {
        throw new FetchError(err instanceof Error ? err.message : String(err), size);
      }
      return Buffer.concat(chunks);
    },
  };
}
