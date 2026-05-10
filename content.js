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
const ACTION_INJECT = "ACTION_INJECT";   // background → content after mapping

// ── SPA Observer State ───────────────────────────────────────
//
//  isZanshinActive  — armed to true on the first ACTION_AUTOFILL message;
//                     stays true for the lifetime of the tab so the observer
//                     can re-fire executeZanshinStrike() on every SPA transition.
//
//  observerTimeout  — debounce handle; cleared and re-set on every batch of
//                     mutations so we fire at most once per DOM quiet period.
//
//  _spaObserverRef  — singleton guard; prevents double-initialisation if the
//                     user presses Autofill more than once.
let isZanshinActive = false;
let observerTimeout = null;
let _spaObserverRef = null;

// ── Helpers ──────────────────────────────────────────────────

/**
 * Shadow DOM Piercer — Big Tech Bypass (Phase 3.3)
 *
 * Recursively queries for `selector` starting at `root`, descending
 * into every element's `.shadowRoot` along the way.  This is the only
 * reliable way to find inputs inside Web Components such as those used
 * by Google Jobs, AWS Console career pages, and Optiver's ATS portal.
 *
 * Standard document.querySelectorAll() stops dead at a shadow boundary;
 * this function does not.
 *
 * @param {string}        selector  CSS selector (e.g. "input, select, textarea")
 * @param {Document|ShadowRoot|Element} root  Starting node (defaults to document)
 * @returns {Element[]}  Flat array of all matching elements across all shadow roots
 */
function querySelectorAllDeep(selector, root = document) {
  // Collect matches at the current root level
  const elements = Array.from(root.querySelectorAll(selector));

  // Walk every element in this root and recurse into any shadow roots
  const allElements = Array.from(root.querySelectorAll('*'));
  for (const el of allElements) {
    if (el.shadowRoot) {
      elements.push(...querySelectorAllDeep(selector, el.shadowRoot));
    }
  }

  return elements;
}

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
  if (cs.display === "none") return true;
  if (cs.visibility === "hidden") return true;
  // RELAXED FOR MATERIAL DESIGN: Frameworks often hide native inputs with opacity: 0
  // if (parseFloat(cs.opacity) === 0) return true;

  // 3. Aria-hidden (screen-reader honeypots)
  if (el.getAttribute("aria-hidden") === "true") return true;

  // RELAXED FOR MATERIAL DESIGN: Frameworks often use zero-size backing inputs
  // 4. Zero-size trap (1×1 px off-screen fields)
  // const rect = el.getBoundingClientRect();
  // if (rect.width === 0 && rect.height === 0) return true;

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
  // Use the Shadow DOM piercer so embedded Web Components (Big Tech portals) are included
  const elements = querySelectorAllDeep(selectors);

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
      node: el,                          // live DOM reference — Zero-Query Injection
      id: el.id || null,
      name: el.name || null,
      automationId,
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.placeholder || null,
      label: resolveLabel(el),
      tag: el.tagName.toLowerCase(),
      // Stable selector kept for debugging / legacy ACTION_INJECT path only.
      //   1. id  → #escaped-id
      //   2. name → [name="…"]
      //   3. data-automation-id → [data-automation-id="…"]  (Workday fallback)
      selector: el.id
        ? `#${CSS.escape(el.id)}`
        : el.name
          ? `[name="${CSS.escape(el.name)}"]`
          : automationId
            ? `[data-automation-id="${CSS.escape(automationId)}"]`
            : null,
    };

    // Skip fields with no textual signal at all — resolveFieldKey would return
    // null anyway, so there is nothing to map.  The node reference itself is
    // enough to inject once a mapping is resolved.
    if (!descriptor.id && !descriptor.name && !descriptor.automationId &&
      !descriptor.placeholder && !descriptor.label) {
      console.debug(`${LOG_PREFIX} Skipping signal-less element:`, el);
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

const _INPUT_SETTER = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, "value"
)?.set;

const _TEXTAREA_SETTER = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype, "value"
)?.set;

const _SELECT_SETTER = Object.getOwnPropertyDescriptor(
  window.HTMLSelectElement.prototype, "value"
)?.set;

/**
 * Inject mapped values into the DOM — Zero-Query Injection (Phase 3.4)
 *
 * Accepts the Array<{node, value, label}> produced by mapFieldsLocally().
 * Because the scraper already pinned live DOM references onto each item,
 * there are ZERO querySelector / getElementById calls in this function.
 * Each field is O(1) — just a direct property write + two synthetic events.
 *
 * Each field injection is wrapped in its own try/catch so a single broken
 * field never aborts the rest of the batch.
 *
 * @param {Array<{node: Element, value: string, label: string}>} mappedItems
 */
function injectFieldValues(mappedItems) {
  let injected = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of mappedItems) {
    const { node: el, value, label } = item;

    // Guard: skip empty / null values — nothing to inject
    if (value === null || value === undefined || value === "") {
      console.debug(`${LOG_PREFIX} Skipping empty value for: "${label}"`);
      skipped++;
      continue;
    }

    // Guard: node must still be attached to a live document
    if (!el || !el.isConnected) {
      console.warn(`${LOG_PREFIX} Node for "${label}" is detached — skipping.`);
      skipped++;
      continue;
    }

    // ── Human Guard (SPA re-fire safety) ─────────────────────
    //
    // If the element already has a non-empty value the user may have
    // typed it manually.  We MUST NOT overwrite human input — doing so
    // would both be intrusive and could trigger infinite observer loops
    // (our own synthetic `input` event mutates the DOM → observer fires
    // again → we overwrite again → …).
    //
    // Exemption: radio/checkbox fields are handled separately below and
    // are allowed through because their "value" attribute is static metadata,
    // not user-entered text — the checked state is what matters there.
    if (
      el.type !== "radio" && el.type !== "checkbox" &&
      typeof el.value === "string" && el.value.length > 0
    ) {
      console.debug(`${LOG_PREFIX} [HumanGuard] "${label}" already filled — preserving user input.`);
      skipped++;
      continue;
    }

    try {
      const tag = el.tagName; // "INPUT" | "TEXTAREA" | "SELECT"
      const val = String(value);

      if (tag === "INPUT" && (el.type === "radio" || el.type === "checkbox")) {
        // ── Radio / Checkbox — click-based injection ──────────────
        //
        // We must find the specific sibling radio whose value / label matches
        // the desired string.  The group is resolved via querySelectorAllDeep
        // (Shadow-DOM safe) ONLY here — this is the one place where a sibling
        // scan is unavoidable, but it is scoped to the specific input group.

        const valLower = val.toLowerCase();
        const groupName = el.name;
        const candidates = groupName
          ? querySelectorAllDeep(`input[type="${el.type}"][name="${CSS.escape(groupName)}"]`)
          : [el];

        // Primary match: value attribute (case-insensitive)
        let target = candidates.find((r) => r.value.toLowerCase() === valLower);

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
            `for group "${groupName || label}" — skipping.`
          );
          skipped++;
          continue;
        }

        if (!target.checked) {
          try {
            target.click();
          } catch (_clickErr) {
            const fallbackLabel =
              (target.id && document.querySelector(`label[for="${CSS.escape(target.id)}"]`)) ||
              target.closest("label") ||
              target.nextElementSibling;

            if (fallbackLabel) {
              console.debug(`${LOG_PREFIX} radio.click() threw — falling back to label.click() for "${label}"`);
              fallbackLabel.click();
            } else {
              target.checked = true;
              target.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        } else {
          console.debug(`${LOG_PREFIX} Radio/checkbox "${label}" already in desired state — no-op.`);
        }

        target.style.outline = "2px solid #34a853";
        setTimeout(() => { target.style.outline = ""; }, 2000);

        console.debug(`${LOG_PREFIX} ✓ Clicked radio/checkbox "${label}" → "${val}" [${el.type}]`);
        injected++;
        continue; // ← skip the generic event-dispatch + green-fill block below

      } else if (tag === "INPUT") {
        // ── Standard text / email / url / number inputs ───────────
        if (_INPUT_SETTER) {
          _INPUT_SETTER.call(el, val);
        } else {
          el.value = val;
        }

      } else if (tag === "TEXTAREA") {
        if (_TEXTAREA_SETTER) {
          _TEXTAREA_SETTER.call(el, val);
        } else {
          el.value = val;
        }

      } else if (tag === "SELECT") {
        // Case-insensitive option match so "united kingdom" → "United Kingdom"
        const valLower = val.toLowerCase();
        const matchedOption = Array.from(el.options).find(
          (o) =>
            o.value.toLowerCase() === valLower ||
            o.text.toLowerCase() === valLower
        );

        if (matchedOption) {
          if (_SELECT_SETTER) {
            _SELECT_SETTER.call(el, matchedOption.value);
          } else {
            el.value = matchedOption.value;
          }
        } else {
          console.warn(`${LOG_PREFIX} No matching <option> for "${label}" = "${val}" — skipping.`);
          skipped++;
          continue;
        }

      } else {
        el.value = val;
      }

      // ── Synthetic events — framework state sync ───────────────
      // `input`  → triggers React / Vue onChange / v-model
      // `change` → triggers native <select> / Angular ngModel
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      // ── Visual feedback — transient green fill ─────────────────
      el.style.transition = "background-color 1.8s ease";
      el.style.backgroundColor = "#e6f4ea";
      setTimeout(() => { el.style.backgroundColor = ""; }, 2000);

      console.debug(`${LOG_PREFIX} ✓ Injected "${label}" → "${val}" [${tag}]`);
      injected++;

    } catch (err) {
      console.error(`${LOG_PREFIX} ✗ Failed to inject "${label}": ${err.message}`, err);
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
  // Workday: addressSection_stateDropdown / addressSection_state
  address_state: [
    /addressSection_state/i,         // Workday automation-id
    /state[\s_-]*province/i,         // combined label "State / Province"
    /\bstate\b/i,
    /\bprovince\b/i,
    /\bregion\b/i,
    /\bcounty\b/i,
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
    descriptor.id || "",
    descriptor.name || "",
    descriptor.automationId || "",
    descriptor.placeholder || "",
    descriptor.label || "",
  ].join(" ").toLowerCase();

  if (!signal.trim()) return null;

  let bestKey = null;
  let bestScore = -1;   // lower index in the pattern array = higher score

  for (const [profileKey, patterns] of Object.entries(fieldDictionary)) {
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(signal)) {
        // Score = (total_patterns - index), so index 0 → highest score
        const score = patterns.length - i;
        if (score > bestScore) {
          bestScore = score;
          bestKey = profileKey;
        }
        break; // only the first matching pattern for this key counts
      }
    }
  }

  return bestKey;
}

/**
 * Build an injection list entirely offline — Zero-Query Injection (Phase 3.4)
 *
 * Instead of a flat { elementId: value } dict that forces a second DOM lookup
 * during injection, we now return an Array of objects that carry the live DOM
 * node reference alongside the resolved string value.  The injector can then
 * operate in O(1) per field with zero querySelector calls.
 *
 * Flow:
 *   1. For every scraped field, call resolveFieldKey() to find its EuroProfile key.
 *   2. Look up the value in the stored user profile.
 *   3. Serialize complex values (arrays, objects) to human-readable strings.
 *   4. Push { node, value, label } onto the result array.
 *
 * @param {Array<Object>} formFields   Output of scrapeFormFields()
 * @param {Object}        userProfile  EuroProfile from chrome.storage.local
 * @returns {Array<{node: Element, value: string, label: string}>}
 */
function mapFieldsLocally(formFields, userProfile) {
  const mappedItems = [];

  for (const field of formFields) {
    const profileKey = resolveFieldKey(field);
    if (!profileKey) {
      console.debug(`${LOG_PREFIX} [Heuristic] No match for field:`, field.id || field.name || field.label);
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
      if (rawValue.length === 0) continue;

      const first = rawValue[0];
      if (typeof first === "object" && first !== null) {
        // Array of objects — join key→value pairs
        stringValue = rawValue
          .map((item) => Object.values(item).join(" ").trim())
          .join(", ");
      } else {
        // Simple string array
        stringValue = rawValue.join(", ");
      }
    } else {
      stringValue = String(rawValue);
    }

    // Push the live node reference — no second lookup needed in injectFieldValues
    mappedItems.push({
      node: field.node,
      value: stringValue,
      label: field.label || field.id || field.name || profileKey,
    });

    console.debug(
      `${LOG_PREFIX} [Heuristic] "${field.label || field.id || field.name}" → "${profileKey}" = "${stringValue}"`
    );
  }

  console.info(
    `${LOG_PREFIX} [Heuristic] Resolved ${mappedItems.length} field mapping(s) from ${formFields.length} scraped field(s).`
  );

  return mappedItems;
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

// ============================================================
//  Resume File Injector — Big Tech Bypass (Phase 3.4)
// ============================================================
//
//  Uses the DataTransfer API to simulate a human "drag and drop"
//  file event.  This is the only reliable cross-ATS technique for
//  programmatically populating <input type="file"> fields because:
//
//    • The browser blocks direct assignment of `input.files` (it is
//      a read-only FileList in normal circumstances).
//    • DataTransfer.files is writable and is what the browser itself
//      uses internally when the user drops a file.
//    • The subsequent `change` event is indistinguishable from a
//      real user interaction at the framework level.

/**
 * Convert the profile's Base64-encoded PDF into a simulated file drop on
 * the first matching <input type="file"> found in the DOM.
 *
 * Step 1: Accepts the full userProfile object (not just base64String) so
 *         we can derive a dynamic, ATS-organic file name from the candidate's
 *         real name — e.g. "Rishwik_Mishra_Resume.pdf" — rather than a
 *         static string that bot-detection heuristics can fingerprint.
 *
 * Matching criteria for the upload target (any attribute containing):
 *   id / name / accept → "resume", "cv", "upload", or ".pdf"
 *
 * @param {Object|null} userProfile  Full EuroProfile from chrome.storage.local.
 *                                   Returns immediately if falsy or has no resume.
 */
function injectResumeFile(userProfile) {
  // ── Step 1: Early return guard ───────────────────────────────────
  if (!userProfile || !userProfile.resume_base64) {
    console.debug(`${LOG_PREFIX} [Resume] No resume_base64 in profile — skipping file injection.`);
    return;
  }

  const base64String = userProfile.resume_base64;

  // ── Step 2: Dynamic file name from real candidate names ──────────
  //
  // Trim and replace interior whitespace with underscores so the file
  // name looks like a human typed it ("Rishwik_Mishra_Resume.pdf").
  // Fallbacks prevent an ugly "undefined_undefined_Resume.pdf" if the
  // profile happens to be missing name fields.
  const firstName = userProfile.legal_first_name
    ? userProfile.legal_first_name.trim().replace(/\s+/g, "_")
    : "Candidate";
  const lastName = userProfile.legal_last_name
    ? userProfile.legal_last_name.trim().replace(/\s+/g, "_")
    : "Resume";
  const dynamicFileName = `${firstName}_${lastName}_Resume.pdf`;

  // ── 3. Find the upload input (Shadow-DOM aware, Workday-hardened) ──
  //
  //  Problem: Workday deeply nests <input type="file"> inside Web
  //  Components.  The element itself carries no meaningful id/name and
  //  its `accept` attribute is often empty, so the old 3-field check
  //  produced zero signal and silently skipped the upload.
  //
  //  Solution — Deep Context Climber:
  //    a. Walk up to 4 ancestor levels and concatenate their innerText.
  //    b. Separately extract data-automation-id from the input itself or
  //       the nearest ancestor that carries one (Workday's primary signal).
  //    c. Combine everything — own attributes + automationId + ancestor
  //       text — into one lowercase contextString tested against an
  //       expanded keyword regex.
  //
  //  Regex coverage:
  //    resume / cv / upload / .pdf   — generic ATS patterns
  //    document / attachment / file  — iCIMS / Taleo label text
  //    resumeUpload / resumeAttach   — Workday automation-id values
  //    fileupload                    — Greenhouse input name pattern
  const allFileInputs = querySelectorAllDeep('input[type="file"]');

  const RESUME_KEYWORDS =
    /resume|cv|upload|\.pdf|document|attachment|resumeupload|resumeattach|fileupload/i;

  const target = allFileInputs.find((input) => {
    // ── a. Deep Context Climber: walk up 5 ancestor levels (Shadow-DOM piercing) ────────────
    let parentText = "";
    // Start with parent, or jump the shadow boundary immediately if it's the root child
    let currentParent = input.parentElement || (input.getRootNode && input.getRootNode().host);
    let depth = 0;

    // Climb up to 5 levels, crossing shadow boundaries
    while (currentParent && depth < 5) {
      parentText += (currentParent.innerText || currentParent.textContent || "") + " ";
      
      // Move up to the next parent, or jump the shadow boundary
      currentParent = currentParent.parentElement || (currentParent.getRootNode && currentParent.getRootNode().host);
      depth++;
    }

    // ── b. Workday automation-id extraction ───────────────────────────
    //  Check the input itself first; if absent, walk up to the nearest
    //  ancestor that carries one (Workday wraps inputs in a component
    //  whose root element holds the data-automation-id).
    const automationId =
      input.getAttribute("data-automation-id") ||
      (input.closest("[data-automation-id]")?.getAttribute("data-automation-id")) ||
      "";

    // ── c. Comprehensive context string ───────────────────────────────
    //
    //  Two-step normalization:
    //    1. Lowercase — standard case-insensitive baseline.
    //    2. NFD + diacritic strip — decomposes composed Unicode characters
    //       into base letter + combining accent, then removes the accents.
    //       This turns "résumé" → "resume" so the RESUME_KEYWORDS regex
    //       matches Google Careers (and any other portal using accented text)
    //       without requiring us to add accent variants to the regex itself.
    const rawContext = [
      input.id,
      input.name,
      input.accept,
      input.getAttribute("aria-label") || "",
      automationId,
      parentText,
    ].join(" | ").toLowerCase();

    // Normalize diacritics (e.g., turn "résumé" into "resume")
    const contextString = rawContext.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    return RESUME_KEYWORDS.test(contextString);
  });

  if (!target) {
    console.warn(
      `${LOG_PREFIX} [Resume] No <input type="file"> matched resume keywords ` +
      `(checked id, name, accept, aria-label, data-automation-id, and 4-level parent text) — skipping.`
    );
    return;
  }

  // ── 3b. Dual-Layer Idempotency Guard — Echo Effect + SPA Visual State ──
  //
  //  Two failure modes addressed here:
  //
  //  Failure Mode A — "Classic Echo" (all SPAs):
  //    Our `change` event → DOM mutation → MutationObserver fires →
  //    executeZanshinStrike() called again → injectResumeFile() called again.
  //    Guard 1 catches this: the native FileList still holds our File object.
  //
  //  Failure Mode B — "Workday React Clear" (Workday / React SPAs):
  //    After reading the file, the React framework renders a "Successfully
  //    Uploaded" card and then programmatically CLEARS the underlying
  //    <input type="file"> state (input.files becomes empty).  Guard 1
  //    sees files.length === 0 and would incorrectly proceed to inject again.
  //    Guard 2 catches this: the filename is already visible in the rendered
  //    DOM text — proof the upload card has been painted.

  // Guard 1: Native input state (fast, O(1))
  if (target.files && target.files.length > 0) {
    console.log(`[Zanshin] Native input already holds a file. Skipping.`);
    return;
  }

  // Guard 2: Visual State (React/SPA Bypass)
  // Scan the rendered page text for the dynamically generated filename.
  // If it's visible anywhere on screen the upload card was already rendered —
  // injecting again would duplicate the file and trigger a second change event.
  if (document.body.innerText.includes(dynamicFileName)) {
    console.warn(
      `[Zanshin] Visual State Guard triggered: '${dynamicFileName}' is already rendered on screen. ` +
      `Skipping duplicate injection.`
    );
    return;
  }

  // ── 4. Base64 → Blob → File ───────────────────────────────────────
  //
  // atob() decodes Base64 to a binary string; we then copy each char's
  // char-code into a Uint8Array so the Blob constructor receives raw bytes.
  let uint8;
  try {
    const binaryString = atob(base64String);
    uint8 = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      uint8[i] = binaryString.charCodeAt(i);
    }
  } catch (decodeErr) {
    console.error(`${LOG_PREFIX} [Resume] Base64 decode failed:`, decodeErr);
    return;
  }

  const blob = new Blob([uint8], { type: "application/pdf" });
  // Use the dynamic name — ATS systems log the File.name property;
  // a generic "Zanshin_Resume.pdf" is a trivial bot-detection signal.
  const file = new File([blob], dynamicFileName, { type: "application/pdf" });

  // ── 5. DataTransfer drag-and-drop simulation ──────────────────────
  //
  // Assigning directly to input.files throws a TypeError (read-only).
  // DataTransfer.files IS writable; assigning it to input.files then
  // fires an authentic FileList that the ATS framework trusts.
  const dt = new DataTransfer();
  dt.items.add(file);
  target.files = dt.files;

  // ── 6. Dispatch change event — framework state sync ──────────────
  target.dispatchEvent(new Event("change", { bubbles: true }));

  // ── 7. Visual feedback ────────────────────────────────────────────
  target.style.outline = "2px solid #34a853";
  setTimeout(() => { target.style.outline = ""; }, 2000);

  console.info(
    `${LOG_PREFIX} [Resume] ✅ Injected "${dynamicFileName}" (${file.size} bytes) ` +
    `via DataTransfer into ${target.id || target.name || '<file input>'}.`
  );
}

// ============================================================
//  executeZanshinStrike — Idempotent Autofill Pipeline
// ============================================================
//
//  Encapsulates the full scrape → map → inject pipeline so it can
//  be called from both the message listener (user click) AND the
//  MutationObserver (autonomous SPA re-fire).
//
//  Returns an object: { success, injected, error? }
//  The caller decides whether to relay this to the popup or log it.

/**
 * Run the full Zanshin autofill pipeline against the current DOM.
 *
 * Idempotent: the Human Guard inside injectFieldValues() ensures that
 * already-filled fields are never overwritten, so calling this function
 * multiple times on the same page is safe.
 *
 * @returns {Promise<{success: boolean, injected: number, error?: string}>}
 */
async function executeZanshinStrike() {
  console.info(`${LOG_PREFIX} ⚡ executeZanshinStrike — scanning DOM.`);

  try {
    // 1. Load the EuroProfile from chrome.storage.local
    //    NOTE: This is the first Chrome API call in the pipeline.
    //    If the extension was reloaded/updated while this tab was open,
    //    Chrome invalidates the extension context — every chrome.* API
    //    call from this point throws "Extension context invalidated".
    //    The catch block below handles that specific case gracefully.
    const stored = await chrome.storage.local.get(["zanshin_user_profile"]);
    const userProfile = stored.zanshin_user_profile;

    if (!userProfile) {
      console.warn(`${LOG_PREFIX} Vault is empty — strike aborted.`);
      return { success: false, injected: 0, error: "Vault is empty. Load a profile in the extension popup first." };
    }

    // 2. Scrape visible form fields (honeypot-safe, Shadow-DOM aware)
    const formFields = scrapeFormFields();

    if (formFields.length === 0) {
      console.warn(`${LOG_PREFIX} No form fields detected — strike aborted.`);
      return { success: false, injected: 0, error: "No form fields detected on this page." };
    }

    // 3. Deterministic heuristic mapping (zero network cost)
    const mappedItems = mapFieldsLocally(formFields, userProfile);

    if (mappedItems.length === 0) {
      console.warn(`${LOG_PREFIX} No fields matched the profile — strike aborted.`);
      return { success: false, injected: 0, error: "No recognisable form fields matched the profile." };
    }

    // 4. Inject text fields + resume file concurrently
    //    The Human Guard inside injectFieldValues() prevents overwriting manual input.
    await Promise.all([
      Promise.resolve(injectFieldValues(mappedItems)),
      Promise.resolve(injectResumeFile(userProfile)),
    ]);

    const injectedCount = mappedItems.length;
    console.info(`${LOG_PREFIX} ✅ Strike complete — ${injectedCount} field(s) processed.`);
    return { success: true, injected: injectedCount };

  } catch (error) {
    // ── Graceful Shutdown — Extension Context Invalidated ───────────────
    //
    //  Triggered when: the extension is updated or force-reloaded via
    //  chrome://extensions while the content script is still alive in
    //  a tab.  Chrome tears down the old context but the MutationObserver
    //  (and any pending debounce timers) keep firing — each call to a
    //  chrome.* API then throws this specific error message.
    //
    //  Action: disconnect the orphaned observer, disarm isZanshinActive,
    //  and return silently.  The user must click Autofill again once the
    //  new extension context is ready.
    if (error.message && error.message.includes("Extension context invalidated")) {
      console.warn(`[Zanshin] Extension was reloaded. Disconnecting orphaned SPA Observer.`);
      if (_spaObserverRef) {
        _spaObserverRef.disconnect();
        _spaObserverRef = null; // release the singleton so it can be re-created
      }
      isZanshinActive = false;
      return { success: false, injected: 0, error: "Extension reloaded — please click Autofill again." };
    }

    // All other errors are unexpected — surface them for debugging
    console.error(`[Zanshin] Strike failed:`, error);
    return { success: false, injected: 0, error: error.message };
  }
}

// ============================================================
//  initializeSPAObserver — Smart MutationObserver
// ============================================================
//
//  Watches document.body for new child nodes that contain form inputs
//  (i.e. SPA route transitions) and debounces a re-fire of
//  executeZanshinStrike() 800 ms after the DOM settles.
//
//  Safety guarantees:
//    1. Singleton — only one observer is ever created per content script
//       lifetime (_spaObserverRef guard).
//    2. No `attributes` watch — our own synthetic `input`/`change` event
//       dispatches do NOT trigger this observer.
//    3. isZanshinActive flag — observer is passive until the user has
//       clicked Autofill at least once.
//    4. Human Guard in injectFieldValues — prevents overwriting on re-fire.

/**
 * Instantiate (or no-op if already running) the SPA MutationObserver.
 * Call once after the first successful ACTION_AUTOFILL.
 */
function initializeSPAObserver() {
  // Singleton guard — do not register a second observer
  if (_spaObserverRef) {
    console.debug(`${LOG_PREFIX} [SPA] Observer already active — skipping re-init.`);
    return;
  }

  const observer = new MutationObserver((mutations) => {
    // ── Filter: only care about mutations that added form-bearing nodes ──
    let hasNewFormNode = false;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        // Only HTMLElements can host inputs
        if (!(node instanceof HTMLElement)) continue;

        // Does this subtree contain at least one form control?
        if (
          node.matches("input, select, textarea") ||
          node.querySelector("input, select, textarea")
        ) {
          hasNewFormNode = true;
          break;
        }
      }
      if (hasNewFormNode) break;
    }

    if (!hasNewFormNode) return; // nothing relevant mutated

    // ── Debounce: reset the 800 ms quiet-period timer ────────────────
    clearTimeout(observerTimeout);
    observerTimeout = setTimeout(async () => {
      if (!isZanshinActive) return; // user hasn't armed us yet

      console.info(`${LOG_PREFIX} [SPA] New form nodes detected — firing autonomous strike.`);
      try {
        await executeZanshinStrike();
      } catch (err) {
        console.error(`${LOG_PREFIX} [SPA] Autonomous strike failed:`, err);
      }
    }, 800);
  });

  // Watch only childList + subtree — NOT attributes, to avoid loops
  observer.observe(document.body, { childList: true, subtree: true });

  _spaObserverRef = observer; // store singleton reference
  console.info(`${LOG_PREFIX} [SPA] MutationObserver armed — watching for SPA transitions.`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── ACTION_AUTOFILL — Zero-Touch Autonomy (Phase 3.5) ───────
  //
  //  On first click:
  //    1. Arm isZanshinActive so the SPA observer is live for this tab.
  //    2. Run executeZanshinStrike() on the currently visible form.
  //    3. Spin up initializeSPAObserver() (singleton — safe to call again).
  //    4. Respond to the popup with the result of the initial strike.
  if (message.action === ACTION_AUTOFILL) {
    console.info(`${LOG_PREFIX} ACTION_AUTOFILL received — arming Zero-Touch Autonomy.`);

    (async () => {
      try {
        // ── Step 3a: Arm the observer for the tab's lifetime ─────────
        isZanshinActive = true;

        // ── Step 3b: Immediately autofill the visible form ───────────
        const result = await executeZanshinStrike();

        // ── Step 3c: Start the SPA observer (no-op if already running) ─
        initializeSPAObserver();

        // ── Relay result to popup ─────────────────────────────────────
        sendResponse(result);

      } catch (err) {
        console.error(`${LOG_PREFIX} ❌ ACTION_AUTOFILL threw:`, err);
        sendResponse({ success: false, injected: 0, error: err.message });
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

