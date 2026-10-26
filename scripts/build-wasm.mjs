// Build the Rust engine for the browser and place it where Vite picks it up.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';

execFileSync('cargo', ['build', '-p', 'chronos-engine-wasm', '--target', 'wasm32-unknown-unknown', '--release'], { stdio: 'inherit' });
mkdirSync('src/wasm', { recursive: true });
copyFileSync('target/wasm32-unknown-unknown/release/chronos_engine_wasm.wasm', 'src/wasm/chronos.wasm');
