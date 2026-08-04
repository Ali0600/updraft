import { z } from 'zod';

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

/** Protocol versions this server speaks. */
export const SUPPORTED_PROTOCOL_VERSIONS = [0, 1] as const;

export const assetSchema = z.object({
  hash: z.string().min(1),
  key: z.string().min(1),
  contentType: z.string().min(1),
  fileExtension: z.string().optional(),
  url: z.url(),
});
export type ManifestAsset = z.infer<typeof assetSchema>;

export const manifestSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  runtimeVersion: z.string().min(1),
  launchAsset: assetSchema,
  assets: z.array(assetSchema),
  metadata: z.record(z.string(), z.unknown()),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * Directives tell a client to do something other than apply an update.
 * `rollBackToEmbedded` sends it back to the bundle shipped inside the binary.
 */
export const DIRECTIVE_TYPES = ['rollBackToEmbedded', 'noUpdateAvailable'] as const;
export type DirectiveType = (typeof DIRECTIVE_TYPES)[number];

export const directiveSchema = z.object({
  type: z.enum(DIRECTIVE_TYPES),
  parameters: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type Directive = z.infer<typeof directiveSchema>;

export function rollBackToEmbeddedDirective(commitTime: string): Directive {
  return { type: 'rollBackToEmbedded', parameters: { commitTime } };
}
