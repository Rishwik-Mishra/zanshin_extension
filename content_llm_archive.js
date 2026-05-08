// ============================================================
//  content_llm_archive.js — Zanshin Extension (ARCHIVED)
// ============================================================
//
//  ⚠️  TOKEN ECONOMICS PIVOT — Phase 3.2
//  This file archives the LLM-based ACTION_AUTOFILL handler that was
//  active in content.js up to Phase 3.1.
//
//  Original flow:
//    1. ACTION_AUTOFILL received from popup.js.
//    2. scrapeFormFields() collects all visible DOM field descriptors.
//    3. Descriptors are relayed to background.js via RELAY_TO_API.
//    4. background.js POSTs the fields + EuroProfile to /api/map-fields.
//    5. Gemini 2.5 Flash resolves a { field_id: value } mapping.
//    6. The mapping is injected into the DOM via injectFieldValues().
//
//  To restore:
//    1. Copy the chrome.runtime.onMessage.addListener block below back
//       into content.js, replacing the heuristic regex handler.
//    2. Ensure background.js still has the RELAY_TO_API → /api/map-fields
//       fetch logic active.
//    3. Set GEMINI_API_KEY in backend/.env and restart uvicorn.
//
//  ⚠️  DO NOT link this file in manifest.json — backup only.
// ============================================================

/*

// ── Message Listener (LLM path — archived Phase 3.1) ─────────
//
// MV3 async messaging contract:
//   • The listener must synchronously return `true` to signal that
//     `sendResponse` will be called asynchronously.
//   • All async work lives inside an async IIFE so errors are caught.
//   • `sendResponse` is called EXACTLY ONCE — either in the `try`
//     block (success) or in the `catch` block (failure).
//   • `return true` is the LAST synchronous statement in the listener,
//     placed outside the async IIFE so it always executes immediately.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── ACTION_AUTOFILL ───────────────────────────────────────
  if (message.action === ACTION_AUTOFILL) {
    console.info(`${LOG_PREFIX} ACTION_AUTOFILL received — starting DOM scrape.`);

    (async () => {
      try {
        // 1. Scrape visible form fields
        const formFields = scrapeFormFields();

        if (formFields.length === 0) {
          console.warn(`${LOG_PREFIX} No valid form fields found on this page.`);
          sendResponse({ success: false, error: "No form fields detected on this page." });
          return;
        }

        // 2. Relay to background.js (CSP-safe fetch proxy).
        //    chrome.runtime.sendMessage is callback-based, so we wrap it
        //    in a Promise so we can await it cleanly in this async IIFE.
        const apiResponse = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { action: "RELAY_TO_API", formFields },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(response);
              }
            }
          );
        });

        if (!apiResponse?.success) {
          const errMsg = apiResponse?.error || "Unknown API error from background relay.";
          console.error(`${LOG_PREFIX} API mapping failed:`, errMsg);
          sendResponse({ success: false, error: errMsg });
          return;
        }

        // 3. Inject the AI-resolved mapping into the DOM
        injectFieldValues(apiResponse.mapping);
        const injectedCount = Object.keys(apiResponse.mapping).length;
        console.info(`${LOG_PREFIX} ✅ Injection complete — ${injectedCount} field(s).`);

        // 4. SUCCESS — respond to popup
        sendResponse({ success: true, injected: injectedCount });

      } catch (err) {
        // Any unexpected error (network, parsing, injection) lands here.
        // We MUST call sendResponse here or the popup gets the channel-
        // closed error that triggered this rewrite.
        console.error(`${LOG_PREFIX} ❌ Autofill pipeline threw:`, err);
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // ← keep port open; MUST be synchronous & outside the IIFE
  }

  // ── ACTION_INJECT (direct injection, no API round-trip) ──
  if (message.action === ACTION_INJECT) {
    (async () => {
      try {
        injectFieldValues(message.mapping || {});
        sendResponse({ success: true });
      } catch (err) {
        console.error(`${LOG_PREFIX} ❌ ACTION_INJECT failed:`, err);
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true;
  }

});

*/
