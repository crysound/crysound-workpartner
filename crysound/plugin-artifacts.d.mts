/** Pinned release metadata for the company Feishu plugin. */
export const FEISHU: Readonly<{ name: string; file: string; url: string; integrity: string }>
/** Container dependency specifier. */
export const WEB_SPEC: string
/** Relocatable desktop dependency specifier, relative to the profile. */
export const DESKTOP_WANT: string
/** Verify the downloaded archive before packaging or staging it. */
export function verifyArchive(bytes: Uint8Array): void
/** Download and verify the release in the packaging directory. */
export function downloadArchive(directory: string): Promise<void>
/** Copy pinned archives into the desktop profile and resolve install/recorded specifiers. */
export function desktopPlugins<T extends { readonly name: string; readonly spec: string; readonly want: string }>(plugins: readonly T[], artifacts: string, profile: string): (T & { spec: string; want: string })[]
