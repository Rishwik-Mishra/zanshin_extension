// ============================================================
//  Zanshin Content Script — content.js  (Phase 3.1)
//  DOM Scraper & Autofill Injector
//
//  Responsibilities:
//    1. Listen for ACTION_AUTOFILL from the popup / background.
//    2. Scrape all visible, interactive form fields (honeypot-safe).
//    3. Relay the field array to background.js (bypasses page CSP).
//    4. Receive the AI field-mapping and inject values into the DOM.
// ============================================================

"use strict";

// ── Constants ────────────────────────────────────────────────
const LOG_PREFIX = "[Zanshin:Content]";
const ACTION_AUTOFILL = "ACTION_AUTOFILL";
const ACTION_INJECT   = "ACTION_INJECT";   // background → content after mapping

// ── Helpers ──────────────────────────────────────────────────

/**
 * Returns true when the element is hidden via any of the ATS
 * honeypot techniques we must NOT touch.
 *
 * Checks:
 *   - type="hidden"  (native hidden input)
 *   - display: none  (CSS / inline style)
 *   - visibility: hidden
 *   - opacity: 0
 *   - aria-hidden="true"
 *
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isHoneypot(el) {
  // 1. Native hidden input
  if (el.type === "hidden") return true;

  // 2. Computed style checks (catches CSS-class-based hiding)
  const cs = window.getComputedStyle(el);
  if (cs.display     === "none")    return true;
  if (cs.visibility  === "hidden")  return true;
  if (parseFloat(cs.opacity) === 0) return true;

  // 3. Aria-hidden (screen-reader honeypots)
  if (el.getAttribute("aria-hidden") === "true") return true;

  // 4. Zero-size trap (1×1 px off-screen fields)
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;

  return false;
}

/**
 * Attempt to find the human-readable label for a form element.
 * Priority order:
 *   1. aria-label attribute
 *   2. aria-labelledby → referenced element text
 *   3. <label for="id"> element text
 *   4. Closest wrapping <label> text
 *   5. Preceding <label> sibling text
 *
 * @param {HTMLElement} el
 * @returns {string}
 */
function resolveLabel(el) {
  // 1. aria-label (fastest, most explicit)
  const ariaLabel = (el.getAttribute("aria-label") || "").trim();
  if (ariaLabel) return ariaLabel;

  // 2. aria-labelledby → dereference
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) return refEl.innerText.trim();
  }

  // 3. <label for="element-id">
  if (el.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (forLabel) return forLabel.innerText.trim();
  }

  // 4. Closest wrapping <label>
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) return wrappingLabel.innerText.trim();

  // 5. Previous sibling that is a <label>
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.tagName === "LABEL") return prev.innerText.trim();
    prev = prev.previousElementSibling;
  }

  return "";
}

/**
 * Scrape all visible, interactive form fields from the current DOM.
 * Returns an array of field-descriptor objects.
 *
 * @returns {Array<Object>}
 */
function scrapeFormFields() {
  const selectors = "input, select, textarea";
  const elements  = Array.from(document.querySelectorAll(selectors));

  const fields = [];

  for (const el of elements) {
    // ── Honeypot filter ──────────────────────────────────────
    if (isHoneypot(el)) {
      console.debug(`${LOG_PREFIX} Skipping honeypot element:`, el);
      continue;
    }

    // ── Build field descriptor ───────────────────────────────
    const descriptor = {
      id:          el.id          || null,
      name:        el.name        || null,
      type:        el.type        || el.tagName.toLowerCase(),
      placeholder: el.placeholder || null,
      label:       resolveLabel(el),
      tag:         el.tagName.toLowerCase(),
      // Stable selector for injection step — prefer id, fallback name
      selector:    el.id
                     ? `#${CSS.escape(el.id)}`
                     : el.name
                       ? `[name="${CSS.escape(el.name)}"]`
                       : null,
    };

    // Skip fields with no usable identifier (can't inject back)
    if (!descriptor.id && !descriptor.name) {
      console.debug(`${LOG_PREFIX} Skipping anonymous element (no id/name):`, el);
      continue;
    }

    fields.push(descriptor);
  }

  console.info(`${LOG_PREFIX} Scraped ${fields.length} visible form field(s).`);
  return fields;
}

// ── Pre-cache native prototype setters (module-load time) ────
//
// Retrieving these once at the top is both faster and safer than
// fetching them inside the loop.  More importantly, it lets us pick
// the EXACT setter that matches the element's own prototype chain,
// which is what prevents the "Illegal invocation" TypeError.
//
// Why does the error happen?
//   Calling HTMLInputElement.prototype's 'value' setter on a
//   <textarea> node is a cross-prototype invocation — the internal
//   [[Call]] slot checks that `this` is an HTMLInputElement and
//   throws TypeError when it isn't.  We must call each setter only
//   on elements that belong to that exact prototype.

const _INPUT_SETTER    = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,    "value"
)?.set;

const _TEXTAREA_SETTER = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype, "value"
)?.set;

const _SELECT_SETTER   = Object.getOwnPropertyDescriptor(
  window.HTMLSelectElement.prototype,   "value"
)?.set;

/**
 * Inject the AI-resolved field mapping into the DOM.
 *
 * Uses tag-specific native prototype setters so React / Vue / Angular
 * controlled inputs register the programmatic change without throwing
 * "Illegal invocation".
 *
 * Each field injection is wrapped in its own try/catch so a single
 * broken field never aborts the rest of the batch.
 *
 * @param {Object} mapping  e.g. { "first_name": "Alice", "email": "alice@example.com" }
 */
function injectFieldValues(mapping) {
  let injected = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const [key, value] of Object.entries(mapping)) {
    // Skip empty / null values — nothing to inject
    if (value === null || value === undefined || value === "") {
      console.debug(`${LOG_PREFIX} Skipping empty value for key: "${key}"`);
      skipped++;
      continue;
    }

    // ── 1. Resolve DOM element ────────────────────────────────
    const el =
      document.getElementById(key) ||
      document.querySelector(`[name="${CSS.escape(key)}"]`);

    if (!el) {
      console.warn(`${LOG_PREFIX} No DOM element found for key: "${key}"`);
      skipped++;
      continue;
    }

    // ── 2. Per-field try/catch: one bad field never kills the batch ──
    try {
      const tag = el.tagName; // "INPUT" | "TEXTAREA" | "SELECT"
      const val = String(value);

      // ── 3. Tag-specific native setter dispatch ────────────────
      if (tag === "INPUT") {
        if (_INPUT_SETTER) {
          _INPUT_SETTER.call(el, val);
        } else {
          el.value = val; // safety fallback (should never be needed)
        }

      } else if (tag === "TEXTAREA") {
        if (_TEXTAREA_SETTER) {
          _TEXTAREA_SETTER.call(el, val);
        } else {
          el.value = val;
        }

      } else if (tag === "SELECT") {
        // For <select>, first try direct value assignment via the native setter.
        // If the exact value isn't an option, fall back to a case-insensitive
        // text/value search so "united kingdom" matches "United Kingdom".
        const valLower = val.toLowerCase();
        const matchedOption = Array.from(el.options).find(
          (o) =>
            o.value.toLowerCase() === valLower ||
            o.text.toLowerCase()  === valLower
        );

        if (matchedOption) {
          if (_SELECT_SETTER) {
            _SELECT_SETTER.call(el, matchedOption.value);
          } else {
            el.value = matchedOption.value;
          }
        } else {
          console.warn(
            `${LOG_PREFIX} No matching <option> for "${key}" = "${val}" — skipping.`
          );
          skipped++;
          continue;
        }

      } else {
        // Fallback for any other element that exposes a value property
        el.value = val;
      }

      // ── 4. Synthetic events — framework state sync ────────────
      // `input`  → triggers React / Vue onChange / v-model
      // `change` → triggers native <select> / Angular ngModel
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      // ── 5. Visual feedback — transient green fill ─────────────
      // Inline transition so the glow fades out naturally without
      // requiring any external CSS on the host page.
      el.style.transition       = "background-color 1.8s ease";
      el.style.backgroundColor  = "#e6f4ea";
      // Fade back to transparent after 2 s so the page's own styles win
      setTimeout(() => { el.style.backgroundColor = ""; }, 2000);

      console.debug(`${LOG_PREFIX} ✓ Injected "${key}" → "${val}" [${tag}]`);
      injected++;

    } catch (err) {
      // One field failing (e.g., cross-origin iframe element) must not
      // stop the rest of the mapping from being applied.
      console.error(
        `${LOG_PREFIX} ✗ Failed to inject "${key}": ${err.message}`,
        err
      );
      failed++;
    }
  }

  console.info(
    `${LOG_PREFIX} Injection complete — ` +
    `${injected} filled | ${skipped} skipped | ${failed} failed.`
  );
}


// ── Message Listener ─────────────────────────────────────────
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

console.info(`${LOG_PREFIX} Content script loaded and listening.`);
