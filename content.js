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
    // automationId: Workday uses data-automation-id instead of id/name.
    const automationId = el.getAttribute("data-automation-id") || null;

    const descriptor = {
      id:          el.id          || null,
      name:        el.name        || null,
      automationId,
      type:        el.type        || el.tagName.toLowerCase(),
      placeholder: el.placeholder || null,
      label:       resolveLabel(el),
      tag:         el.tagName.toLowerCase(),
      // Stable selector for injection step:
      //   1. id  → #escaped-id
      //   2. name → [name="…"]
      //   3. data-automation-id → [data-automation-id="…"]  (Workday fallback)
      selector:    el.id
                     ? `#${CSS.escape(el.id)}`
                     : el.name
                       ? `[name="${CSS.escape(el.name)}"]`
                       : automationId
                         ? `[data-automation-id="${CSS.escape(automationId)}"]`
                         : null,
    };

    // Skip fields with no usable identifier whatsoever (can't inject back)
    if (!descriptor.id && !descriptor.name && !descriptor.automationId) {
      console.debug(`${LOG_PREFIX} Skipping anonymous element (no id/name/automationId):`, el);
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

      if (tag === "INPUT" && (el.type === "radio" || el.type === "checkbox")) {
        // ── Radio / Checkbox — click-based injection ──────────────
        //
        // Custom UI frameworks (React, Bootstrap, MUI, Workday's WD
        // component library) intercept user events via synthetic event
        // listeners attached to the document root.  Setting `.checked`
        // or firing a manual `change` event bypasses those listeners,
        // causing the visual UI to stay out of sync even though the DOM
        // property updates.
        //
        // Solution: simulate a real human click.
        //
        // For radio groups the mapping value is the desired option label
        // (e.g. "Male").  We find the specific radio whose `value` matches
        // case-insensitively, then click only that element.

        const valLower = val.toLowerCase();

        // All radios/checkboxes sharing the same `name` form a group.
        // If the element has no name, treat it as a lone element.
        const groupName = el.name;
        const candidates = groupName
          ? Array.from(document.querySelectorAll(
              `input[type="${el.type}"][name="${CSS.escape(groupName)}"]`
            ))
          : [el];

        // Primary match: value attribute (case-insensitive)
        let target = candidates.find(
          (r) => r.value.toLowerCase() === valLower
        );

        // Secondary match: adjacent/wrapping label text (Lever/Bootstrap pattern)
        if (!target) {
          target = candidates.find((r) => {
            const lbl =
              (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) ||
              r.closest("label") ||
              r.nextElementSibling;
            return lbl && lbl.textContent.trim().toLowerCase() === valLower;
          });
        }

        if (!target) {
          console.warn(
            `${LOG_PREFIX} No radio/checkbox option matching "${val}" ` +
            `for group "${groupName || key}" — skipping.`
          );
          skipped++;
          continue;
        }

        // Guard: skip if already in the desired state (idempotent)
        if (!target.checked) {
          // ── Primary: simulate a real click on the input itself ────
          // Fires the full browser event chain so React / Vue / Angular
          // reconcile their internal state trees.
          try {
            target.click();
          } catch (_clickErr) {
            // ── Fallback: click the associated <label> instead ────────
            // Some frameworks (e.g. Workday WD library) visually detach
            // the <input> from the rendered component tree.  Clicking the
            // wrapping or associated label triggers the framework's own
            // pointer-event handler and achieves the visual state update.
            const fallbackLabel =
              (target.id && document.querySelector(`label[for="${CSS.escape(target.id)}"]`)) ||
              target.closest("label") ||
              target.nextElementSibling;

            if (fallbackLabel) {
              console.debug(
                `${LOG_PREFIX} radio.click() threw — falling back to label.click() for "${key}"`
              );
              fallbackLabel.click();
            } else {
              // Last resort: force-set + dispatch (will miss framework listeners)
              target.checked = true;
              target.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        } else {
          console.debug(`${LOG_PREFIX} Radio/checkbox "${key}" already in desired state — no-op.`);
        }

        // Transient green outline as visual feedback
        target.style.outline = "2px solid #34a853";
        setTimeout(() => { target.style.outline = ""; }, 2000);

        console.debug(`${LOG_PREFIX} ✓ Clicked radio/checkbox "${key}" → "${val}" [${el.type}]`);
        injected++;
        continue; // ← skip the generic event-dispatch + green-fill block below

      } else if (tag === "INPUT") {
        // ── Standard text / email / url / number inputs ───────────
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


// ============================================================
//  Heuristic Regex Engine — Token Economics Pivot (Phase 3.2)
// ============================================================
//
//  Replaces the LLM relay path (archived in content_llm_archive.js).
//  All field mapping is now performed 100% offline, in-process, with
//  zero network calls and zero API cost.
//
//  Architecture:
//    fieldDictionary  — maps each EuroProfile key to an ordered list
//                       of regex patterns, ranked by specificity.
//    mapFieldsLocally — scores every scraped field descriptor against
//                       the dictionary and resolves a { selector: profileKey }
//                       mapping used by injectFieldValues().
//
//  To restore the LLM path:
//    1. Copy the archived listener from content_llm_archive.js back here.
//    2. Remove the fieldDictionary + mapFieldsLocally block below.
// ============================================================

// ── Heuristic Dictionary ─────────────────────────────────────
//
//  Each key is an EuroProfile field name.
//  Each value is an ordered array of regexes — earlier patterns are
//  more specific and win ties when multiple keys could match the same
//  DOM attribute.  All regexes are case-insensitive (/i flag).

// ── Zanshin Dictionary v3.0 ──────────────────────────────────
//
//  Platform coverage:
//    Workday   — camelCase data-automation-id values
//                (legalNameSection_firstName, dateSectionYear, …)
//    Greenhouse — snake_case ids + free-text question_#### labels
//    Lever     — custom label text, minimal html id discipline
//    Taleo     — class-based ids, label-heavy matching
//    iCIMS     — mixed camelCase ids + aria-label
//
//  Pattern ordering: most-specific (longest, platform-pinned) first;
//  generic catch-alls last.  resolveFieldKey() picks the highest-
//  scoring (earliest-matching) pattern across all keys.

const fieldDictionary = {
  // ── Core Identity ──────────────────────────────────────────
  // Workday: legalNameSection_firstName / legalNameSection_lastName
  // Greenhouse: first_name / last_name
  // Lever/Taleo: label "First Name" / "Last Name"
  // iCIMS: firstName / lastName camelCase ids
  legal_first_name: [
    /legalNamesection_firstName/i,   // Workday exact automation-id
    /first[\s_-]*name/i,             // Greenhouse snake_case + label
    /given[\s_-]*name/i,             // alt label variant
    /^fname$/i,                      // short-form id
    /firstName/i,                    // iCIMS camelCase id
    /\bfirst\b/i,                    // bare label fallback
  ],
  legal_last_name: [
    /legalNamesection_lastName/i,    // Workday exact automation-id
    /last[\s_-]*name/i,              // Greenhouse + label
    /surname/i,
    /family[\s_-]*name/i,
    /^lname$/i,
    /lastName/i,                     // iCIMS camelCase
    /\blast\b/i,                     // bare label fallback
  ],

  // ── Contact ────────────────────────────────────────────────
  email: [
    /email/i,
    /e-mail/i,
    /^mail$/i,
  ],
  phone_with_country_code: [
    /phone/i,
    /mobile/i,
    /cell/i,
    /contact.*number/i,
    /telephone/i,
  ],

  // ── Location ───────────────────────────────────────────────
  // Workday: addressSection_city / addressSection_countryDropdown
  // iCIMS: city / country selects
  address_city: [
    /addressSection_city/i,          // Workday automation-id
    /city/i,
    /town/i,
    /locality/i,
    /\blocation\b/i,
  ],
  address_country: [
    /addressSection_country/i,       // Workday automation-id
    /country/i,
    /nation/i,
  ],

  // ── Professional Links ─────────────────────────────────────
  // Greenhouse uses free-text labels like "LinkedIn Profile"
  // on inputs with opaque ids such as "question_12345678".
  // Matching on label text is therefore the primary signal here.
  linkedin_url: [
    /linkedin/i,
    /linked-in/i,
  ],
  github_url: [
    /github/i,
    /git-hub/i,
  ],
  portfolio_url: [
    /portfolio/i,
    /website/i,
    /personal.*site/i,
    /web.*page/i,
  ],

  // ── Education ──────────────────────────────────────────────
  // Workday: educationSection_degree / educationSection_school
  // iCIMS:   highestEducationLevel select
  highest_education_level: [
    /educationSection_degree/i,      // Workday automation-id
    /education[\s_-]*level/i,
    /degree/i,
    /qualification/i,
    /major/i,
    /education/i,
  ],
  university_name: [
    /educationSection_school/i,      // Workday automation-id
    /university/i,
    /college/i,
    /institution/i,
    /school/i,
  ],
  // Workday: dateSectionYear appears on the education end-date picker
  graduation_year: [
    /dateSectionYear/i,              // Workday automation-id
    /grad.*year/i,
    /class.*of/i,
    /year.*graduated/i,
  ],

  // ── Experience ─────────────────────────────────────────────
  total_years_experience: [
    /years.*experience/i,
    /total.*experience/i,
  ],
  current_notice_period_days: [
    /notice.*period/i,
    /availability/i,
    /\bnotice\b/i,
  ],

  // ── Demographics & Address ─────────────────────────────────
  // gender: covers both "Gender" labels and "Sex" dropdown ids.
  // current_address: full street-line field; kept deliberately
  //   broad so it fires on "address", "street", "address line 1", etc.
  //   Placed last so it never outscores the more-specific address_city
  //   / address_country entries (which appear earlier in the dict and
  //   carry higher index-0 specificity scores).
  gender: [
    /\bgender\b/i,
    /\bsex\b/i,
  ],
  current_address: [
    /address[\s_-]*line[\s_-]*1/i,    // most specific — "Address Line 1"
    /street[\s_-]*address/i,          // "Street Address"
    /\bstreet\b/i,
    /\baddress\b/i,                   // generic fallback
  ],
};

/**
 * Resolve the best-matching EuroProfile key for a single field descriptor.
 *
 * Scoring strategy:
 *   - Build a single "signal string" from the field's id, name,
 *     placeholder, and label (all lowercased, space-separated).
 *   - For every EuroProfile key in fieldDictionary, test each regex in
 *     order.  The FIRST match for a key records a score; earlier patterns
 *     in the array score higher (more specific = lower index = higher score).
 *   - The key with the highest score wins.  Ties are broken by the order
 *     keys appear in fieldDictionary (more-specific keys come first).
 *
 * @param {Object} descriptor  A field descriptor from scrapeFormFields()
 * @returns {string|null}      The matching EuroProfile key, or null
 */
function resolveFieldKey(descriptor) {
  // Combine all textual signals into one searchable string.
  // automationId is included so Workday data-automation-id values
  // (e.g. "legalNameSection_firstName") are matched by the dictionary.
  const signal = [
    descriptor.id          || "",
    descriptor.name        || "",
    descriptor.automationId || "",
    descriptor.placeholder || "",
    descriptor.label       || "",
  ].join(" ").toLowerCase();

  if (!signal.trim()) return null;

  let bestKey   = null;
  let bestScore = -1;   // lower index in the pattern array = higher score

  for (const [profileKey, patterns] of Object.entries(fieldDictionary)) {
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(signal)) {
        // Score = (total_patterns - index), so index 0 → highest score
        const score = patterns.length - i;
        if (score > bestScore) {
          bestScore = score;
          bestKey   = profileKey;
        }
        break; // only the first matching pattern for this key counts
      }
    }
  }

  return bestKey;
}

/**
 * Build a { selector → profileValue } mapping entirely offline.
 *
 * Flow:
 *   1. For every scraped field, call resolveFieldKey() to find its
 *      EuroProfile key via the heuristic dictionary.
 *   2. Look up the value in the stored user profile.
 *   3. Serialize complex values (arrays, objects) to human-readable strings.
 *   4. Return a flat mapping ready for injectFieldValues().
 *
 * @param {Array<Object>} formFields   Output of scrapeFormFields()
 * @param {Object}        userProfile  EuroProfile from chrome.storage.local
 * @returns {Object}  { elementIdOrName: stringValue }
 */
function mapFieldsLocally(formFields, userProfile) {
  const mapping = {};

  for (const field of formFields) {
    const profileKey = resolveFieldKey(field);
    if (!profileKey) {
      console.debug(`${LOG_PREFIX} [Heuristic] No match for field:`, field.id || field.name);
      continue;
    }

    const rawValue = userProfile[profileKey];

    // Skip null / undefined / empty profile values
    if (rawValue === null || rawValue === undefined || rawValue === "") {
      console.debug(`${LOG_PREFIX} [Heuristic] Profile key "${profileKey}" is empty — skipping.`);
      continue;
    }

    // ── Serialize complex types ───────────────────────────────
    let stringValue;

    if (Array.isArray(rawValue)) {
      // e.g. visa_status_by_country → "EU: Citizen · India: Requires Sponsorship"
      //      cefr_languages         → "English (C1), Hindi (Native)"
      //      tech_stack             → "React, FastAPI, Python"
      if (rawValue.length === 0) continue;

      const first = rawValue[0];
      if (typeof first === "object" && first !== null) {
        // Array of objects — join key→value pairs
        stringValue = rawValue
          .map((item) =>
            Object.values(item).join(" ").trim()
          )
          .join(", ");
      } else {
        // Simple string array
        stringValue = rawValue.join(", ");
      }
    } else {
      stringValue = String(rawValue);
    }

    // ── Determine the injection key (id preferred, else name) ──
    const injectionKey = field.id || field.name;
    if (!injectionKey) continue;  // already filtered by scrapeFormFields, but be safe

    mapping[injectionKey] = stringValue;

    console.debug(
      `${LOG_PREFIX} [Heuristic] "${injectionKey}" → "${profileKey}" = "${stringValue}"`
    );
  }

  console.info(
    `${LOG_PREFIX} [Heuristic] Resolved ${Object.keys(mapping).length} field mapping(s) from ${formFields.length} scraped field(s).`
  );

  return mapping;
}


// ── Message Listener (Heuristic path — Phase 3.2) ────────────
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

  // ── ACTION_AUTOFILL — heuristic regex path (no network call) ─
  if (message.action === ACTION_AUTOFILL) {
    console.info(`${LOG_PREFIX} ACTION_AUTOFILL received — starting offline heuristic mapping.`);

    (async () => {
      try {
        // 1. Scrape visible form fields
        const formFields = scrapeFormFields();

        if (formFields.length === 0) {
          console.warn(`${LOG_PREFIX} No valid form fields found on this page.`);
          sendResponse({ success: false, error: "No form fields detected on this page." });
          return;
        }

        // 2. Load the EuroProfile from chrome.storage.local (set by Mock Vault / live parser)
        const stored = await chrome.storage.local.get(["zanshin_user_profile"]);
        const userProfile = stored.zanshin_user_profile;

        if (!userProfile) {
          console.warn(`${LOG_PREFIX} No profile found in vault — load one first (press 1–4).`);
          sendResponse({ success: false, error: "Vault is empty. Load a profile in the extension popup first." });
          return;
        }

        // 3. Resolve mapping using the heuristic regex engine (zero network cost)
        const mapping = mapFieldsLocally(formFields, userProfile);

        if (Object.keys(mapping).length === 0) {
          console.warn(`${LOG_PREFIX} Heuristic engine found no matching fields.`);
          sendResponse({ success: false, error: "No recognisable form fields matched the profile." });
          return;
        }

        // 4. Inject resolved values into the DOM
        injectFieldValues(mapping);
        const injectedCount = Object.keys(mapping).length;
        console.info(`${LOG_PREFIX} ✅ Heuristic autofill complete — ${injectedCount} field(s).`);

        // 5. SUCCESS — respond to popup
        sendResponse({ success: true, injected: injectedCount });

      } catch (err) {
        console.error(`${LOG_PREFIX} ❌ Autofill pipeline threw:`, err);
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // ← keep port open; MUST be synchronous & outside the IIFE
  }

  // ── ACTION_INJECT (direct injection, no mapping step) ────────
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

console.info(`${LOG_PREFIX} Content script loaded — heuristic regex engine active.`);

