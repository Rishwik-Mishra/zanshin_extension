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
const resetBtn = document.getElementById("reset-btn");
const errorBanner = document.getElementById("error-banner");
const errorMsg = document.getElementById("error-msg");

// ── Backend URL ──────────────────────────────────────────────
const API_URL = "http://127.0.0.1:8000/api/parse-resume";

// ── State ───────────────────────────────────────────────────
let selectedFile = null;

// ── Relational Vault ─────────────────────────────────────────
//  Caches Base64 resume strings keyed by profile number (1-4).
//  Populated from chrome.storage on init; updated on every upload.
let userResumeCache = { 1: null, 2: null, 3: null, 4: null };
let currentActiveProfileNumber = null;

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
    { label: "Name", value: name || "—" },
    { label: "Email", value: profile.email || "—" },
    { label: "Location", value: location },
    { label: "LinkedIn", value: profile.linkedin_url || "—" },
    { label: "Education", value: profile.highest_education_level || "—" },
    { label: "Graduated", value: profile.graduation_year || "—" },
    { label: "Experience", value: experience },
    { label: "Notice", value: notice },
    { label: "Languages", value: languages },
    { label: "Visa", value: visaEntries },
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
      zanshin_secured_at: new Date().toISOString(),
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
    // Hydrate the Relational Vault cache before anything else
    const stored = await chrome.storage.local.get([
      "zanshin_user_profile",
      "zanshin_vault_status",
      "zanshin_resume_cache",
    ]);

    if (stored.zanshin_resume_cache) {
      // Merge persisted cache into our in-memory object (preserving defaults)
      Object.assign(userResumeCache, stored.zanshin_resume_cache);
      console.log("[Zanshin] Relational Vault cache hydrated from storage.");
    }

    if (stored.zanshin_vault_status === "secured" && stored.zanshin_user_profile) {
      console.log("[Zanshin] Existing vault loaded on popup open.");
      showSuccessPanel(stored.zanshin_user_profile);
    }
  } catch (err) {
    console.warn("[Zanshin] Could not read storage on init:", err);
  }
})();

// ── Phase 3.2 — Production autofill action trigger ───────────
const autofillBtn = document.getElementById("autofill-action-btn");
const AUTOFILL_LABEL = "⚡ Autofill Application";
const LOADING_LABEL = "Injecting Data…";

/**
 * Set the autofill button into loading or idle state.
 * @param {boolean} isLoading
 * @param {string}  [label] - optional override for the idle label
 */
function setAutofillLoading(isLoading, label = AUTOFILL_LABEL) {
  autofillBtn.disabled = isLoading;
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

// ============================================================
//  Mock Vault — Token Economics Pivot (Phase 3.2)
// ============================================================
//
//  Keyboard shortcut: press '1', '2', '3', or '4' while the
//  popup is open to instantly load the corresponding hardcoded
//  EuroProfile into chrome.storage.local, then show the success
//  panel — no backend call, no API cost, zero latency.
//
//  Profiles strictly match the EuroProfile Pydantic mega-schema
//  (see backend/main.py → class EuroProfile).
//
//  To restore live Gemini parsing:
//    1. Remove or comment out this entire block.
//    2. Restore the parse_resume endpoint from main_gemini_archive.py.
//
// ── Storage Constraints (MUST READ before editing resume_base64) ─
//
//  Chrome enforces a default 5 MB quota on chrome.storage.local.
//  We do NOT request the `unlimitedStorage` permission — it requires
//  additional review and is unnecessary for a single-resume workflow.
//
//  Rules that ALL upload handlers and vault writers MUST follow:
//
//    1. ONE resume per user, ever.  Storing multiple PDFs as Base64
//       strings would exhaust the quota in 2-3 files.
//
//    2. Hard file-size limit: < 2 MB raw (≈ 2.67 MB Base64).
//       Reject any upload exceeding this before encoding.
//       Example guard:
//         if (file.size > 2 * 1024 * 1024) { showError("Resume must be under 2 MB"); return; }
//
//    3. ALWAYS OVERWRITE — never append.  When saving a new resume,
//       write `resume_base64` as a single chrome.storage.local.set()
//       call that replaces the existing value entirely.
//       Never accumulate multiple base64 keys.
//
//    4. When the user clears their vault, explicitly set
//       `resume_base64: null` to reclaim the quota immediately.
// ============================================================

const mockVault = {
  "1": {
    legal_first_name: "Rishwik",
    legal_last_name: "Mishra",
    preferred_name: null,
    address_city: "Bangalore",
    address_country: "India",
    email: "rishwik.mishra@example.com",
    phone_with_country_code: "+91 9876543210",
    linkedin_url: "https://linkedin.com/in/rishwik-mishra",
    github_url: "https://github.com/rishwik-mishra",
    portfolio_url: "https://rishwik.dev",
    highest_education_level: "Bachelor's Degree",
    university_name: "Nitte Meenakshi Institute of Technology",
    graduation_year: "2027",
    total_years_experience: 1.5,
    current_notice_period_days: 30,
    visa_status_by_country: [
      { country: "EU", status: "Requires Sponsorship" },
      { country: "India", status: "Citizen" },
    ],
    cefr_languages: [
      { language: "English", level: "C1" },
      { language: "Hindi", level: "Native" },
    ],
    tech_stack: ["React", "FastAPI", "Python", "Node.js"],
    gender: "Male",
    current_address: "12 MG Road, Bangalore, India",
    address_state: "Karnataka",
    // Minimal valid single-page PDF — "Hello World" in Times-Roman, 559 bytes raw.
    // Generated offline; safe to use as a DataTransfer injection test fixture.
    // OVERWRITE this value (never append) to stay within the Chrome 5 MB quota.
    resume_base64: "JVBERi0xLjcKCjEgMCBvYmogICUgZW50cnkgcG9pbnQKPDwKICAvVHlwZSAvQ2F0YWxvZwogIC9QYWdlcyAyIDAgUgo+PgplbmRvYmoKCjIgMCBvYmoKPDwKICAvVHlwZSAvUGFnZXMKICAvTWVkaWFCb3ggWyAwIDAgMjAwIDIwMCBdCiAgL0NvdW50IDEKICAvS2lkcyBbIDMgMCBSIF0KPj4KZW5kb2JqCgozIDAgb2JqCjw8CiAgL1R5cGUgL1BhZ2UKICAvUGFyZW50IDIgMCBSCiAgL1Jlc291cmNlcyA8PAogICAgL0ZvbnQgPDwKICAgICAgL0YxIDQgMCBSCgkJPj4KICA+PgogIC9Db250ZW50cyA1IDAgUgo+PgplbmRvYmoKCjQgMCBvYmoKPDwKICAvVHlwZSAvRm9udAogIC9TdWJ0eXBlIC9UeXBlMQogIC9CYXNlRm9udCAvVGltZXMtUm9tYW4KPj4KZW5kb2JqCgo1IDAgb2JqCjw8IC9MZW5ndGggMzggPj4Kc3RyZWFtCkJUCi9GMSAxOCBUZgoyMCAxNTAgVGQKKEhlbGxvIFdvcmxkKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTAgMDAwMDAgbiAKMDAwMDAwMDA2NyAwMDAwMCBuIAowMDAwMDAwMTYxIDAwMDAwIG4gCjAwMDAwMDAyNjAgMDAwMDAgbiAKMDAwMDAwMDM0NiAwMDAwMCBuIAp0cmFpbGVyCjw8CiAgL1NpemUgNgogIC9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgo0MzYKJSVFT0YK",
  },

  "2": {
    legal_first_name: "Sarah",
    legal_last_name: "Jenkins",
    preferred_name: "Sarah",
    address_city: "Berlin",
    address_country: "Germany",
    email: "sarah.j.frontend@example.com",
    phone_with_country_code: "+49 151 23456789",
    linkedin_url: "https://linkedin.com/in/sarahjenkins",
    github_url: "https://github.com/sarah-ui",
    portfolio_url: null,
    highest_education_level: "Master's Degree",
    university_name: "Technical University of Munich",
    graduation_year: "2023",
    total_years_experience: 4.0,
    current_notice_period_days: 60,
    visa_status_by_country: [
      { country: "Germany", status: "Blue Card" },
    ],
    cefr_languages: [
      { language: "English", level: "Native" },
      { language: "German", level: "B2" },
    ],
    tech_stack: ["Vue.js", "TypeScript", "Tailwind", "Figma"],
    gender: "Female",
    current_address: "Friedrichstrasse 45, Berlin, Germany",
    address_state: "Berlin",
    resume_base64: null, // No resume stored — upload via the popup to populate.
  },

  "3": {
    legal_first_name: "David",
    legal_last_name: "Chen",
    preferred_name: "Dave",
    address_city: "London",
    address_country: "UK",
    email: "d.chen.data@example.com",
    phone_with_country_code: "+44 7911 123456",
    linkedin_url: "https://linkedin.com/in/davidchendata",
    github_url: "https://github.com/dchen-ml",
    portfolio_url: null,
    highest_education_level: "PhD",
    university_name: "Imperial College London",
    graduation_year: "2022",
    total_years_experience: 3.5,
    current_notice_period_days: 15,
    visa_status_by_country: [
      { country: "UK", status: "Indefinite Leave to Remain" },
    ],
    cefr_languages: [
      { language: "English", level: "Native" },
      { language: "Mandarin", level: "Native" },
    ],
    tech_stack: ["Python", "PyTorch", "SQL", "Pandas"],
    gender: "Male",
    current_address: "15 Exhibition Road, London, UK",
    address_state: "England",
    resume_base64: null, // No resume stored — upload via the popup to populate.
  },

  "4": {
    legal_first_name: "Elena",
    legal_last_name: "Rossi",
    preferred_name: null,
    address_city: "Milan",
    address_country: "Italy",
    email: "elena.product@example.com",
    phone_with_country_code: "+39 333 1234567",
    linkedin_url: "https://linkedin.com/in/elenarossipm",
    github_url: null,
    portfolio_url: null,
    highest_education_level: "Bachelor's Degree",
    university_name: "Politecnico di Milano",
    graduation_year: "2020",
    total_years_experience: 6.0,
    current_notice_period_days: 90,
    visa_status_by_country: [
      { country: "EU", status: "Citizen" },
    ],
    cefr_languages: [
      { language: "Italian", level: "Native" },
      { language: "English", level: "C1" },
      { language: "French", level: "B1" },
    ],
    tech_stack: ["Jira", "Agile", "Scrum", "SQL"],
    gender: "Other",
    current_address: "Via Torino 8, Milan, Italy",
    address_state: "Lombardy",
    resume_base64: null, // No resume stored — upload via the popup to populate.
  },
};

// ── Mock Vault keyboard trigger ──────────────────────────────
//
//  Pressing '1'–'4' anywhere in the popup document loads the
//  matching profile from mockVault into chrome.storage.local
//  and immediately shows the success panel — no network call.
//
document.addEventListener("keydown", async (e) => {
  const key = e.key; // "1" | "2" | "3" | "4" | anything else

  if (!["1", "2", "3", "4"].includes(key)) return; // ignore all other keys

  const baseProfile = mockVault[key];
  if (!baseProfile) return; // defensive — should never happen

  // ── Step 2 (Step 3 in spec): Set active profile number ─────
  currentActiveProfileNumber = parseInt(key, 10);

  console.log(
    `[Zanshin MockVault] Loading profile ${key}: ${baseProfile.legal_first_name} ${baseProfile.legal_last_name}`
  );

  // ── Merge Relational Vault resume into the base profile ────
  //  Deep-copy the base object so we never mutate mockVault.
  await _saveActiveProfile();

  // Transition to success UI — reuses the exact same function as the API path
  showSuccessPanel(_getMergedProfile());

  // Update the upload status label to reflect vault state
  _refreshUploadStatus();
});

// ── Relational Vault helpers ──────────────────────────────────

/**
 * Returns the mockVault base profile merged with any cached resume_base64
 * for the currently active profile number.
 * @returns {object}
 */
function _getMergedProfile() {
  if (!currentActiveProfileNumber) return null;

  const key = String(currentActiveProfileNumber);
  const base = { ...mockVault[key] }; // shallow copy — avoids mutating mockVault

  // Overlay the persisted resume (or null if none)
  base.resume_base64 = userResumeCache[currentActiveProfileNumber] ?? null;

  return base;
}

/**
 * Persists the merged profile (base + resume) to `zanshin_user_profile`
 * so content.js always has access to the latest combined data.
 */
async function _saveActiveProfile() {
  const merged = _getMergedProfile();
  if (!merged) return;

  await chrome.storage.local.set({
    zanshin_user_profile: merged,
    zanshin_vault_status: "secured",
    zanshin_secured_at: new Date().toISOString(),
  });

  console.log(
    `[Zanshin RelationalVault] Profile ${currentActiveProfileNumber} synced — ` +
    `resume_base64: ${merged.resume_base64 ? "✅ attached" : "null"}`
  );
}

/**
 * Updates the #uploadStatus paragraph text and CSS class
 * based on whether a resume is currently in the cache for the active profile.
 */
function _refreshUploadStatus() {
  const el = document.getElementById("uploadStatus");
  const label = document.getElementById("vault-upload-trigger-label");
  if (!el) return;

  if (!currentActiveProfileNumber) {
    el.textContent = "";
    el.className = "";
    return;
  }

  const hasResume = !!userResumeCache[currentActiveProfileNumber];
  el.textContent = hasResume
    ? `✅ Resume attached to Profile ${currentActiveProfileNumber}`
    : `No resume attached — click above to upload`;
  el.className = hasResume ? "status-ok" : "";

  if (label) {
    label.textContent = hasResume
      ? `Replace PDF for Profile ${currentActiveProfileNumber} (max 2 MB)`
      : `Click to attach PDF (max 2 MB)`;
  }
}

// ── Resume upload trigger (Relational Vault) ─────────────────
const vaultUploadTrigger = document.getElementById("vault-upload-trigger");
const resumeUploadInput = document.getElementById("resumeUpload");
const uploadStatus = document.getElementById("uploadStatus");

// Clicking the styled trigger fires the hidden native input
if (vaultUploadTrigger && resumeUploadInput) {
  vaultUploadTrigger.addEventListener("click", () => resumeUploadInput.click());
  vaultUploadTrigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") resumeUploadInput.click();
  });
}

// ── FileReader & Uploader (Step 4 in spec) ───────────────────
if (resumeUploadInput) {
  resumeUploadInput.addEventListener("change", () => {
    const file = resumeUploadInput.files && resumeUploadInput.files[0];
    if (!file) return;

    // Guard: must have an active profile loaded first
    if (!currentActiveProfileNumber) {
      uploadStatus.textContent = "Error: Press 1–4 to select a profile first.";
      uploadStatus.className = "status-err";
      resumeUploadInput.value = "";
      return;
    }

    // ── Step 4.1: Validate file size (hard 2 MB limit) ───────
    const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
    if (file.size > MAX_BYTES) {
      uploadStatus.textContent = "Error: File exceeds 2MB limit.";
      uploadStatus.className = "status-err";
      resumeUploadInput.value = "";
      return;
    }

    uploadStatus.textContent = "Reading file…";
    uploadStatus.className = "";

    // ── Step 4.2: Read file as Base64 data URL ───────────────
    const reader = new FileReader();
    reader.readAsDataURL(file);

    // ── Step 4.3–4.7: Process in the onload callback ─────────
    reader.onload = async (event) => {
      try {
        const dataUrl = event.target.result; // "data:application/pdf;base64,<...>"

        // Strip the data-URL prefix — store only the raw Base64 payload
        const rawBase64 = dataUrl.split(",")[1];

        // ── Step 4.4: Update in-memory cache ─────────────────
        userResumeCache[currentActiveProfileNumber] = rawBase64;

        // ── Step 4.5: Persist the entire cache object ─────────
        await chrome.storage.local.set({ zanshin_resume_cache: { ...userResumeCache } });

        // ── Step 4.6: Re-merge and sync the active profile ────
        await _saveActiveProfile();

        // ── Step 4.7: Success feedback ────────────────────────
        uploadStatus.textContent =
          `✅ Resume saved to Profile ${currentActiveProfileNumber}!`;
        uploadStatus.className = "status-ok";

        // Refresh the trigger label
        _refreshUploadStatus();

        console.log(
          `[Zanshin RelationalVault] PDF encoded & saved → profile slot ${currentActiveProfileNumber}` +
          ` (${(rawBase64.length / 1024).toFixed(1)} KB base64).`
        );
      } catch (err) {
        console.error("[Zanshin RelationalVault] Upload failed:", err);
        uploadStatus.textContent = `Error: ${err.message}`;
        uploadStatus.className = "status-err";
      } finally {
        // Reset input so same file can be re-uploaded if needed
        resumeUploadInput.value = "";
      }
    };

    reader.onerror = () => {
      uploadStatus.textContent = "Error: Could not read the file.";
      uploadStatus.className = "status-err";
      resumeUploadInput.value = "";
    };
  });
}
