// ============================================================
//  Zanshin Background Service Worker — background.js  (Phase 3.1)
//  MV3 Relay: CSP bypass + API gateway
//
//  Responsibilities:
//    1. Initialise the secure vault on first install (Phase 1).
//    2. Relay: receive scraped form fields from content.js,
//       fetch user profile from chrome.storage.local, POST both
//       to /api/map-fields, return AI mapping back to content.js.
// ============================================================

"use strict";

const LOG_PREFIX  = "[Zanshin:BG]";
const API_BASE    = "http://127.0.0.1:8000";
const MAP_ENDPOINT = `${API_BASE}/api/map-fields`;
const PROFILE_KEY  = "zanshin_user_profile";

// ── Phase 1: Vault initialisation on install ─────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`${LOG_PREFIX} Service Worker booted.`);
  console.log(`${LOG_PREFIX} Install reason: ${details.reason}`);

  const existing = await chrome.storage.local.get(PROFILE_KEY);

  if (!existing[PROFILE_KEY]) {
    await chrome.storage.local.set({
      [PROFILE_KEY]:          null,
      zanshin_vault_status:   "empty",
      zanshin_installed_at:   new Date().toISOString(),
    });
    console.log(`${LOG_PREFIX} Vault initialised — empty state set.`);
  } else {
    console.log(`${LOG_PREFIX} Existing vault detected — skipping initialisation.`);
  }
});

// ── Phase 3.2: Message relay listener (strict MV3 async pattern) ─
//
// MV3 async messaging contract (same rules as content.js):
//   • Listener returns `true` synchronously to hold the port open.
//   • All async work is inside an async IIFE.
//   • `sendResponse` is called EXACTLY ONCE — try (success) or catch (error).
//   • The detached `handleRelayToApi` helper is eliminated; inlining the
//     logic inside the IIFE prevents the service-worker-suspension race
//     that causes "message channel closed before response was received".

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== "RELAY_TO_API") return false; // not our message — don't hold port

  (async () => {
    try {
      const { formFields } = message;
      console.info(`${LOG_PREFIX} Relay triggered — ${formFields?.length ?? 0} field(s) received.`);

      // ── Step 1: Load user profile from vault ───────────────
      const stored     = await chrome.storage.local.get(PROFILE_KEY);
      const userProfile = stored[PROFILE_KEY] ?? null;

      if (!userProfile) {
        console.warn(`${LOG_PREFIX} No user profile in vault — autofill aborted.`);
        sendResponse({
          success: false,
          error: "No resume profile found. Please upload your resume first.",
        });
        return;
      }

      console.info(`${LOG_PREFIX} Profile loaded for: ${userProfile.legal_first_name ?? "unknown"}`);

      // ── Step 2: POST to /api/map-fields ────────────────────
      const httpResponse = await fetch(MAP_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          form_fields:  formFields,
          user_profile: userProfile,
        }),
      });

      if (!httpResponse.ok) {
        let detail = `HTTP ${httpResponse.status}`;
        try {
          const errBody = await httpResponse.json();
          detail = errBody?.detail ?? detail;
        } catch (_) { /* swallow — error body may not be JSON */ }
        throw new Error(`API error: ${detail}`);
      }

      // ── Step 3: Parse mapping from response ────────────────
      const data    = await httpResponse.json();
      const mapping = data.mapping;

      if (!mapping || typeof mapping !== "object") {
        throw new Error("Server returned an invalid mapping payload.");
      }

      console.info(
        `${LOG_PREFIX} Mapping received — ${Object.keys(mapping).length} field(s) resolved.`
      );

      // ── Step 4: SUCCESS — return mapping to content.js ─────
      sendResponse({ success: true, mapping });

    } catch (err) {
      // Any error (storage, network, HTTP, JSON) lands here.
      // Guaranteed sendResponse so the port never closes silently.
      console.error(`${LOG_PREFIX} ❌ Relay pipeline threw:`, err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // ← synchronous, outside IIFE — holds port open for async sendResponse
});
