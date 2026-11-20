// node-pty ships its macOS/Linux `spawn-helper` prebuilds without the execute
// bit, which makes every spawn fail with "posix_spawnp failed". Restore it.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

try {
  const require = createRequire(import.meta.url);
  const prebuilds = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
} catch {
  // node-pty not installed yet or built from source — nothing to fix.
}
