/** Install the company URL adapter. Local desktop has no adapter and keeps loopback URLs. */
export function installPreviewClient({ previewHost, scope }) {
  document.addEventListener("zp-preview-url", (event) => {
    const detail = event.detail;
    let url;
    try { url = new URL(detail.url); } catch (error) { return; }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) return;
    const port = Number(url.port || 80);
    // The gateway independently checks all ports; reserved ports must visibly fail there.
    const target = new URL(`https://${previewHost}/_zp_preview/start`);
    target.searchParams.set("owner", scope);
    target.searchParams.set("port", String(port));
    target.searchParams.set("path", url.pathname + url.search + url.hash);
    detail.url = target.href;
  });
}
