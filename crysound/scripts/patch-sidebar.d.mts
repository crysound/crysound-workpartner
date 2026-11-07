/** Patch the pinned sidebar browser module, or reject an unrecognized artifact. */
export function patchSidebarModule(text: string): string;
/** Patch the pinned workspace browser module without migrating saved data. */
export function patchWorkspaceModule(text: string): string;
/** Patch both modules in a materialized node_modules before integrity manifests are generated. */
export function patchCompanySidebarRuntime(root: string): void;
