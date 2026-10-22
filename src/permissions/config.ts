import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { readJsoncFile } from '../bootstrap/config.js';

export const PermissionsFileSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    additionalDirectories: z.array(z.string()).default([]),
  })
  .strict();

export type PermissionsConfig = z.infer<typeof PermissionsFileSchema>;

export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  allow: ['Read', 'Glob', 'Grep'],
  deny: ['Read(**/.env)', 'Read(**/*.pem)', 'Read(**/.ssh/**)'],
  additionalDirectories: [],
};

export function loadPermissions(configDir: string): PermissionsConfig {
  const file = path.join(configDir, 'permissions.json');
  if (!fs.existsSync(file)) {
    return DEFAULT_PERMISSIONS;
  }
  return loadPermissionsFile(file);
}

export function loadPermissionsFile(file: string): PermissionsConfig {
  return readJsoncFile(file, PermissionsFileSchema);
}
