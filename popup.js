// ============================================================
//  Zanshin popup.js — Phase 1 Core Ingestion Logic
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

// ── Mock Euro-JSON (Phase 1 — simulates Gemini LLM output) ──
const MOCK_EURO_PROFILE = {
  first_name: "Alex",
  last_name: "Schmidt",
  email: "alex.schmidt@example.com",
  linkedin: "linkedin.com/in/alexschmidt",
  nationality: "German",
  visa_sponsorship_needed: false,
  languages: [
    { language: "German", level: "Native" },
    { language: "English", level: "C1" }
  ],
  experience_years: 2,
  notice_period_months: 1
};

// ── State ───────────────────────────────────────────────────
let selectedFile = null;

// ── Helpers ─────────────────────────────────────────────────
function setButtonLoading(isLoading) {
  parseBtn.disabled = isLoading;
  btnIcon.classList.toggle("hidden", isLoading);
  btnSpinner.classList.toggle("hidden", !isLoading);
  btnText.textContent = isLoading ? "Extracting Euro-Profile…" : "Parse & Secure Resume";
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

  const fields = [
    { label: "Name", value: `${profile.first_name} ${profile.last_name}` },
    { label: "Nationality", value: profile.nationality },
    { label: "Email", value: profile.email },
    { label: "LinkedIn", value: profile.linkedin },
    { label: "Experience", value: `${profile.experience_years} yr${profile.experience_years !== 1 ? "s" : ""}` },
    { label: "Notice", value: `${profile.notice_period_months} month${profile.notice_period_months !== 1 ? "s" : ""}` },
    { label: "Visa Needed", value: profile.visa_sponsorship_needed ? "Yes" : "No" },
    { label: "Languages", value: profile.languages.map(l => `${l.language} (${l.level})`).join(", ") },
  ];

  fields.forEach(({ label, value }, i) => {
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

// ── Parse & Secure button ────────────────────────────────────
parseBtn.addEventListener("click", () => {
  if (!selectedFile && !parseBtn.disabled) return;

  // 1. Loading state
  setButtonLoading(true);

  // 2. Simulate 2-second backend latency (future: Python/Gemini call)
  setTimeout(async () => {
    try {
      // 3. Save mock profile to chrome.storage.local
      await chrome.storage.local.set({
        zanshin_user_profile: MOCK_EURO_PROFILE,
        zanshin_vault_status: "secured",
        zanshin_secured_at: new Date().toISOString(),
      });

      console.log("[Zanshin] Profile secured in vault:", MOCK_EURO_PROFILE);

      // 4. Update UI to success state
      showSuccessPanel(MOCK_EURO_PROFILE);

    } catch (err) {
      console.error("[Zanshin] Storage error:", err);
      setButtonLoading(false);
      alert("❌ Failed to save profile. Please try again.");
    }
  }, 2000);
});

// ── Reset button ─────────────────────────────────────────────
resetBtn.addEventListener("click", async () => {
  // Clear vault
  await chrome.storage.local.remove(["zanshin_user_profile", "zanshin_vault_status", "zanshin_secured_at"]);

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
