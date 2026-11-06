/** 无论授权范围多大，密钥、账号状态和浏览器配置都不可访问；同时检查原始路径与规范路径。 */
export function sensitivePath(value) {
  const p = value.replaceAll("\\", "/").toLowerCase();
  const parts = p.split("/");
  return parts.some((part) => /^\.(ssh|gnupg|aws|azure|kube|pki|dsh|docker|password-store|lark-cli|claude.*|codex.*)$/.test(part) ||
      [".netrc", ".npmrc", ".env", ".git-credentials", "keychains", "credentials", "credential manager", "firefox", "chromium", "bravesoftware"].includes(part) ||
      /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.|$)/.test(part) || /^(google-chrome|microsoft-edge|brave-browser)(-|$)/.test(part) || part.startsWith(".env.")) ||
    /\/(\.config\/(gh|gcloud|cloudflare|op|chromium|google-chrome|brave|microsoft-edge)|\.mozilla|\.local\/share\/keyrings)(\/|$)/.test(p) ||
    /\/(library\/(keychains|safari|containers\/com\.apple\.safari|application support\/(google\/chrome|chromium|firefox|bravesoftware|microsoft edge|arc|com\.apple\.tcc))|appdata\/[^/]+\/(microsoft\/(credentials|vault|edge)|google\/chrome|chromium|mozilla|bravesoftware))(\/|$)/.test(p) ||
    /(^|\/)(secure|agent-secrets|docker-data)(\/|$)/.test(p) ||
    /\.(key|pem|p12|pfx|keychain|keychain-db)$/i.test(p);
}
