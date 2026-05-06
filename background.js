// ============================================================
//  Zanshin Background Service Worker — Phase 1
//  Boots on install, initialises empty vault in storage.
// ============================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Zanshin] Background Worker Booted");
  console.log(`[Zanshin] Install reason: ${details.reason}`);

  // Only initialise if no profile already exists (GDPR-safe, no overwrite)
  const existing = await chrome.storage.local.get("zanshin_user_profile");

  if (!existing.zanshin_user_profile) {
    await chrome.storage.local.set({
      zanshin_user_profile: null,
      zanshin_vault_status: "empty",
      zanshin_installed_at: new Date().toISOString(),
    });
    console.log("[Zanshin] Vault initialised — empty state set.");
  } else {
    console.log("[Zanshin] Existing vault detected — skipping initialisation.");
  }
});
