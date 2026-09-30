import * as fs from 'fs';
import * as path from 'path';

let cached: string | undefined;
/** The node-side sampler script (media/monitor/arcmon.sh), shipped inline over ssh. */
export function samplerScript(extensionPath: string): string {
  return (cached ??= fs.readFileSync(path.join(extensionPath, 'media', 'monitor', 'arcmon.sh'), 'utf8'));
}
