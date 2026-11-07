/** Patch the pinned market client module. */
export function patchMarketUi(text: string): string;
/** Patch the market client file in place. */
export function patchMarketUiFile(file: string): void;
/** Patch a materialized node_modules before integrity manifests are generated. */
export function patchCompanyMarketRuntime(root: string): void;
/** Patch the sidebar market entry. */
export function patchMarketSidebar(text: string): string;
