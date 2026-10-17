/** Bundle the kit's public tokens export into the browser canvas palette module. */
import { build } from 'esbuild';
await build({ entryPoints: ['public/src/brand.ts'], outfile: 'public/src/brand.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true });
