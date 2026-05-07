// ============================================================
//  Zanshin popup.js — Phase 2.2  (Live API Integration)
//  Replaces mock setTimeout with real fetch → FastAPI backend
// ============================================================

"use strict";

// ── DOM refs ────────────────────────────────────────────────
const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");
const fileChip = document.getElementById("file-chip");
const fileNameText = document.getElementById("file-name-text");
const parseBtn = document.getElementById("parse-btn");
const btnText = document.getElementById("btn-text");
const btnIcon = document.getElementById("btn-icon");
const btnSpinner = document.getElementById("btn-spinner");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const uploadSection = document.getElementById("upload-section");
const successPanel = document.getElementById("success-panel");
const profileList = document.getElementById("profile-list");
const resetBtn      = document.getElementById("reset-btn");
const errorBanner   = document.getElementById("error-banner");
const errorMsg      = document.getElementById("error-msg");

// ── Backend URL ──────────────────────────────────────────────
const API_URL = "http://127.0.0.1:8000/api/parse-resume";

// ── State ───────────────────────────────────────────────────
let selectedFile = null;

// ── Helpers ─────────────────────────────────────────────────
function setButtonLoading(isLoading, label = "Extracting Mega-Profile via Gemini…") {
  parseBtn.disabled = isLoading;
  btnIcon.classList.toggle("hidden", isLoading);
  btnSpinner.classList.toggle("hidden", !isLoading);
  btnText.textContent = isLoading ? label : "Parse & Secure Resume";
}

// ── Error banner helpers ─────────────────────────────────────
function showError(message) {
  errorMsg.textContent = message;
  errorBanner.style.display = "flex";
}

function clearError() {
  errorBanner.style.display = "none";
  errorMsg.textContent = "";
}

function setVaultStatus(secured) {
  statusDot.className = `status-dot ${secured ? "dot-green" : "dot-gray"}`;
  statusText.textContent = secured ? "Vault Secured" : "Vault Empty";
  statusText.className = `status-label${secured ? " secured" : ""}`;
}

function showFileChip(name) {
  fileNameText.textContent = name;
  fileChip.style.display = "flex";
}

function buildProfileGrid(profile) {
  profileList.innerHTML = "";

  // ── EuroProfile mega-schema key mapping ──────────────────
  const name = [
    profile.legal_first_name,
    profile.preferred_name ? `"${profile.preferred_name}"` : null,
    profile.legal_last_name,
  ].filter(Boolean).join(" ");

  const location = [profile.address_city, profile.address_country]
    .filter(Boolean).join(", ") || "—";

  const experience = profile.total_years_experience !== undefined
    ? `${profile.total_years_experience} yr${profile.total_years_experience !== 1 ? "s" : ""}`
    : "—";

  const notice = profile.current_notice_period_days !== undefined
    ? `${profile.current_notice_period_days} day${profile.current_notice_period_days !== 1 ? "s" : ""}`
    : "—";

  const languages = Array.isArray(profile.cefr_languages) && profile.cefr_languages.length
    ? profile.cefr_languages.map(l => `${l.language} (${l.level})`).join(", ")
    : "—";

  const visaEntries = Array.isArray(profile.visa_status_by_country) && profile.visa_status_by_country.length
    ? profile.visa_status_by_country.map(v => `${v.country}: ${v.status}`).join(" · ")
    : "—";

  const techStack = Array.isArray(profile.tech_stack) && profile.tech_stack.length
    ? profile.tech_stack.slice(0, 8).join(", ") + (profile.tech_stack.length > 8 ? " …" : "")
    : "—";

  const fields = [
    { label: "Name",       value: name || "—" },
    { label: "Email",      value: profile.email || "—" },
    { label: "Location",   value: location },
    { label: "LinkedIn",   value: profile.linkedin_url || "—" },
    { label: "Education",  value: profile.highest_education_level || "—" },
    { label: "Graduated",  value: profile.graduation_year || "—" },
    { label: "Experience", value: experience },
    { label: "Notice",     value: notice },
    { label: "Languages",  value: languages },
    { label: "Visa",       value: visaEntries },
    { label: "Tech Stack", value: techStack },
  ];

  fields.forEach(({ label, value }) => {
    const row = document.createElement("div");
    row.className = "profile-row";
    row.innerHTML = `
      <span class="row-label">${label}</span>
      <span class="row-value">${value}</span>
    `;
    profileList.appendChild(row);
  });
}

function showSuccessPanel(profile) {
  // Swap panels
  uploadSection.style.display = "none";
  successPanel.style.display = "block";

  // Rebuild profile list
  buildProfileGrid(profile);

  // Update header badge
  setVaultStatus(true);

  // Lock parse button into "secured" state
  parseBtn.disabled = true;
  btnIcon.classList.add("hidden");
  btnSpinner.classList.add("hidden");
  btnText.textContent = "Vault Secured ✓";
}

// ── File selection handler ───────────────────────────────────
function handleFileSelected(file) {
  if (!file) return;

  if (file.type !== "application/pdf") {
    alert("⚠️  Please select a valid PDF file.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    alert("⚠️  File size exceeds 5 MB limit.");
    return;
  }

  selectedFile = file;
  showFileChip(file.name);
  parseBtn.disabled = false;
}

// ── File input change ────────────────────────────────────────
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) {
    handleFileSelected(fileInput.files[0]);
  }
});

// ── Drop zone: click opens file picker ──────────────────────
dropZone.addEventListener("click", () => {
  fileInput.click();
});

// ── Drag & drop events ───────────────────────────────────────
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", (e) => {
  // Only remove if leaving the drop zone itself, not a child
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove("drag-over");
  }
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFileSelected(file);
});

// ── Parse & Secure button — Phase 2.2 (live API) ────────────
parseBtn.addEventListener("click", async () => {
  // Guard: must have a file selected
  if (!selectedFile) {
    showError("Please select a PDF resume before parsing.");
    return;
  }

  // Clear any previous error and enter loading state
  clearError();
  setButtonLoading(true);

  try {
    // ── 1. Build multipart/form-data payload ──────────────
    // Do NOT set Content-Type manually — browser adds the boundary
    const formData = new FormData();
    formData.append("file", selectedFile);

    // ── 2. POST to FastAPI backend ────────────────────────
    console.log("[Zanshin] Sending resume to backend:", API_URL);
    const response = await fetch(API_URL, {
      method: "POST",
      body: formData,
    });

    // ── 3. Handle non-2xx HTTP errors ────────────────────
    if (!response.ok) {
      let detail = `Server returned ${response.status}`;
      try {
        const errBody = await response.json();
        detail = errBody.detail || detail;
      } catch (_) { /* ignore JSON parse failures */ }
      throw new Error(detail);
    }

    // ── 4. Parse the EuroProfile JSON ────────────────────
    const euroProfile = await response.json();
    console.log("[Zanshin] EuroProfile received:", euroProfile);

    // ── 5. Persist to chrome.storage.local ───────────────
    await chrome.storage.local.set({
      zanshin_user_profile: euroProfile,
      zanshin_vault_status: "secured",
      zanshin_secured_at:   new Date().toISOString(),
    });
    console.log("[Zanshin] Profile saved to vault.");

    // ── 6. Transition to success UI ───────────────────────
    showSuccessPanel(euroProfile);

  } catch (err) {
    // ── Error state: visible red banner, button reset ─────
    console.error("[Zanshin] Parse failed:", err);
    setButtonLoading(false);

    const isNetworkError = err instanceof TypeError && err.message.includes("fetch");
    showError(
      isNetworkError
        ? "Cannot reach the backend. Is `uvicorn main:app` running on port 8000?"
        : `Parsing failed: ${err.message}`
    );
  }
});

// ── Reset button ─────────────────────────────────────────────
resetBtn.addEventListener("click", async () => {
  // Clear vault
  await chrome.storage.local.remove(["zanshin_user_profile", "zanshin_vault_status", "zanshin_secured_at"]);

  // Clear any stale error banners
  clearError();

  // Reset state
  selectedFile = null;
  fileInput.value = "";
  fileChip.style.display = "none";
  fileNameText.textContent = "";

  // Swap panels
  successPanel.style.display = "none";
  uploadSection.style.display = "block";

  setVaultStatus(false);

  // Restore button to initial state
  parseBtn.disabled = true;
  btnText.textContent = "Parse & Secure Resume";
  btnIcon.classList.remove("hidden");
  btnSpinner.classList.add("hidden");
  parseBtn.style.opacity = "";
});

// ── On popup open: restore state from storage ────────────────
(async function initPopup() {
  try {
    const stored = await chrome.storage.local.get(["zanshin_user_profile", "zanshin_vault_status"]);
    if (stored.zanshin_vault_status === "secured" && stored.zanshin_user_profile) {
      console.log("[Zanshin] Existing vault loaded on popup open.");
      showSuccessPanel(stored.zanshin_user_profile);
    }
  } catch (err) {
    console.warn("[Zanshin] Could not read storage on init:", err);
  }
})();

// ── Phase 3.2 — Production autofill action trigger ───────────
const autofillBtn     = document.getElementById("autofill-action-btn");
const AUTOFILL_LABEL  = "⚡ Autofill Application";
const LOADING_LABEL   = "Injecting Data…";

/**
 * Set the autofill button into loading or idle state.
 * @param {boolean} isLoading
 * @param {string}  [label] - optional override for the idle label
 */
function setAutofillLoading(isLoading, label = AUTOFILL_LABEL) {
  autofillBtn.disabled    = isLoading;
  autofillBtn.textContent = isLoading ? LOADING_LABEL : label;
}

autofillBtn.addEventListener("click", async () => {
  console.log("[Zanshin] ⚡ Autofill Application triggered.");

  // ── Enter loading state immediately ──────────────────────
  setAutofillLoading(true);

  // ── 1. Resolve the active tab ─────────────────────────────
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    console.error("[Zanshin] chrome.tabs.query failed:", err);
    setAutofillLoading(false);
    return;
  }

  const activeTab = tabs?.[0];
  if (!activeTab?.id) {
    console.error("[Zanshin] No active tab found — cannot send message.");
    setAutofillLoading(false);
    return;
  }

  console.log(`[Zanshin] Sending ACTION_AUTOFILL → tab #${activeTab.id} (${activeTab.url})`);

  // ── 2. Dispatch ACTION_AUTOFILL to the content script ─────
  chrome.tabs.sendMessage(
    activeTab.id,
    { action: "ACTION_AUTOFILL" },
    (response) => {
      // ── Error: runtime / messaging failure ───────────────
      if (chrome.runtime.lastError) {
        console.error(
          "[Zanshin] ❌ Message failed — did you reload the target page after loading the extension?\n" +
          "  Error:", chrome.runtime.lastError.message
        );
        setAutofillLoading(false);
        return;
      }

      // ── Error: no response object ─────────────────────────
      if (!response) {
        console.warn("[Zanshin] ⚠️ No response from content script.");
        setAutofillLoading(false);
        return;
      }

      // ── Success path ──────────────────────────────────────
      if (response.success) {
        const count = response.injected ?? 0;
        console.log(`[Zanshin] ✅ Autofill complete — ${count} field(s) injected.`, response);

        // Briefly show confirmation label, then reset to idle
        autofillBtn.textContent = `✅ ${count} field${count !== 1 ? "s" : ""} filled!`;
        setTimeout(() => setAutofillLoading(false), 2000);

      // ── Error path (pipeline error returned from content.js) ──
      } else {
        console.error("[Zanshin] ❌ Autofill pipeline error:", response.error, response);
        setAutofillLoading(false);
      }
    }
  );
});
