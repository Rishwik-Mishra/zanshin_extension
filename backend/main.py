"""
main.py — Zanshin Extension Backend  (Phase 3.1)
=================================================
Lightweight FastAPI proxy that:
  1. Accepts a PDF resume upload.
  2. Extracts text from it in memory (GDPR Art. 25 compliant).
  3. Sends the text to Gemini 2.5 Flash with structured-output enforced
     against the EuroProfile Pydantic schema.
  4. Returns the parsed EuroProfile as JSON to the Chrome extension.
  5. [Phase 3.1] Accepts scraped form fields + a user profile, maps them
     with Gemini acting as an ATS data-mapper, returns a field→value dict.

Run locally:
    uvicorn main:app --reload --port 8000
"""

import json
import logging
import os
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Load environment variables from .env ─────────────────────
load_dotenv()
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")

# ── Logging ──────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("zanshin.backend")

# ── Local utilities ───────────────────────────────────────────
from utils.extractor import process_pdf_bytes  # noqa: E402


# ============================================================
#  Pydantic Schema — EuroProfile (Phase 2.2 — Gemini-safe)
#
#  Gemini structured output rejects open-ended dict[str, str]
#  because it emits additionalProperties in the JSON schema.
#  All complex fields are modelled as strict nested BaseModels
#  with explicit, closed sets of properties.
# ============================================================


class VisaStatus(BaseModel):
    """Single country → visa/work-authorisation status entry."""
    country: str
    status: str


class LanguageSkill(BaseModel):
    """Single language with its CEFR proficiency level."""
    language: str
    level: str


class EuroProfile(BaseModel):
    """
    Exhaustive European job-application profile.
    Serves as both the Gemini response schema and the local
    storage contract for chrome.storage.local.
    """

    # ── Personal identifiers ──────────────────────────────────
    legal_first_name: str
    legal_last_name: str
    preferred_name: str | None = None

    # ── Location ──────────────────────────────────────────────
    address_city: str | None = None
    address_country: str | None = None

    # ── Contact ───────────────────────────────────────────────
    phone_with_country_code: str | None = None
    email: str

    # ── Professional presence ─────────────────────────────────
    linkedin_url: str | None = None
    github_url: str | None = None
    portfolio_url: str | None = None

    # ── Education ─────────────────────────────────────────────
    highest_education_level: str
    university_name: str | None = None
    graduation_year: str | None = None

    # ── Experience ────────────────────────────────────────────
    total_years_experience: float
    current_notice_period_days: int

    # ── Legal / visa (strict list — no open dict) ─────────────
    visa_status_by_country: list[VisaStatus]

    # ── Languages (strict list — no open dict) ────────────────
    cefr_languages: list[LanguageSkill]

    # ── Technical skills ──────────────────────────────────────
    tech_stack: list[str]



# ============================================================
#  FastAPI Application
# ============================================================

app = FastAPI(
    title="Zanshin Autofill — Resume Parser API",
    description=(
        "Serverless-ready FastAPI proxy for the Zanshin Chrome Extension. "
        "Accepts a PDF resume, extracts text in-memory, and returns a "
        "structured EuroProfile via Gemini 2.5 Flash."
    ),
    version="3.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS: allow the unpacked Chrome extension origin ─────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Extension doesn't have a fixed origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
#  Health check
# ============================================================

@app.get("/", tags=["Health"])
async def root() -> dict:
    """Liveness probe — confirms the server is running."""
    return {
        "status": "online",
        "service": "Zanshin Resume Parser",
        "version": "3.1.0",
        "gemini_key_loaded": bool(GEMINI_API_KEY),
    }


# ============================================================
#  POST /api/parse-resume  —  STUB (Token Economics Pivot)
# ============================================================
#
#  ⚠️  DEMO FREEZE: Gemini parsing is temporarily disabled.
#  The full Gemini implementation (2.5-flash → 2.0-flash fallback,
#  PDF extraction, structured output) is archived intact in:
#      backend/main_gemini_archive.py
#
#  The Chrome extension now uses the hardcoded Mock Vault in
#  popup.js (keys 1–4) to populate chrome.storage.local directly,
#  bypassing this endpoint entirely.
#
#  To restore: copy the archived endpoint back here and remove this stub.
# ============================================================

@app.post(
    "/api/parse-resume",
    tags=["Resume Parsing"],
    summary="[STUB] Parse endpoint — disabled for Token Economics Pivot demo",
)
async def parse_resume(
    file: UploadFile = File(..., description="PDF resume file (ignored in stub mode)."),
) -> dict:
    """
    **[DEMO STUB — Phase 3.2 Token Economics Pivot]**

    Gemini parsing is temporarily disabled to eliminate per-request API costs
    during the FYP demo phase.  The extension now uses the Mock Vault in
    `popup.js` to load profile data directly into `chrome.storage.local`.

    This endpoint returns 200 OK so any stale callers do not crash.
    The full Gemini implementation is archived in `main_gemini_archive.py`.
    """
    logger.info(
        "[STUB] /api/parse-resume called for '%s' — returning stub 200 (Mock Vault active).",
        file.filename,
    )
    return {
        "status": "stub",
        "message": (
            "Gemini parsing is disabled for the demo phase. "
            "Load a profile via the Mock Vault (press 1–4 in the extension popup)."
        ),
    }


# ============================================================
#  Phase 3.1 — Pydantic models for /api/map-fields
# ============================================================

class FormField(BaseModel):
    """
    Descriptor for a single DOM form element, as scraped by content.js.
    All fields are optional because not every element will have every
    attribute set (e.g., anonymous inputs have no id).
    """
    id:          Optional[str] = Field(None, description="HTML id attribute of the element")
    name:        Optional[str] = Field(None, description="HTML name attribute of the element")
    type:        Optional[str] = Field(None, description="Input type (text, email, select, etc.)")
    placeholder: Optional[str] = Field(None, description="Placeholder text, if any")
    label:       Optional[str] = Field(None, description="Resolved human-readable label text")
    tag:         Optional[str] = Field(None, description="HTML tag name (input, select, textarea)")
    selector:    Optional[str] = Field(None, description="CSS selector for injection targeting")


class MapFieldsRequest(BaseModel):
    """
    Request body sent by background.js to /api/map-fields.
    Contains the scraped form descriptor array and the user's EuroProfile.
    """
    form_fields:  list[FormField]    = Field(..., description="Scraped form field descriptors")
    user_profile: Dict[str, Any]     = Field(..., description="User's EuroProfile as a plain dict")


class FieldMappingResponse(BaseModel):
    """
    Response returned by /api/map-fields.
    mapping: keys are element id or name; values are the string to inject.
    """
    mapping: Dict[str, str] = Field(
        ...,
        description=(
            "Dictionary mapping each form field identifier (id or name) "
            "to the value that should be injected into that field."
        ),
    )


# ============================================================
#  POST /api/map-fields
# ============================================================

@app.post(
    "/api/map-fields",
    response_model=FieldMappingResponse,
    tags=["Autofill Mapping"],
    summary="Map scraped form fields to user profile values via Gemini",
)
async def map_fields(payload: MapFieldsRequest) -> FieldMappingResponse:
    """
    **Phase 3.1 — ATS field mapper.**

    Flow:
    1. Receive form field descriptors (scraped by content.js) and the
       user's EuroProfile (retrieved from chrome.storage.local by background.js).
    2. Send both to Gemini 2.5 Flash with a strict system instruction to
       act as an ATS data-mapper.
    3. Gemini returns a JSON dict: { "element_id_or_name": "value_to_inject" }.
    4. Validated and returned to background.js, which relays it to content.js
       for DOM injection.

    GDPR: no data is logged or persisted server-side.
    """

    # ── Guard: API key must be configured ────────────────────
    if not GEMINI_API_KEY:
        logger.error("GEMINI_API_KEY not set — aborting map-fields request")
        raise HTTPException(
            status_code=503,
            detail="Gemini API key is not configured. Set GEMINI_API_KEY in your .env file.",
        )

    if not payload.form_fields:
        raise HTTPException(status_code=400, detail="form_fields array is empty.")

    logger.info(
        "map-fields: %d field(s) received for profile '%s %s'",
        len(payload.form_fields),
        payload.user_profile.get("legal_first_name", "?"),
        payload.user_profile.get("legal_last_name",  "?"),
    )

    # ── Serialise inputs for the prompt ──────────────────────
    fields_json   = json.dumps(
        [f.model_dump(exclude_none=True) for f in payload.form_fields],
        indent=2,
    )
    profile_json  = json.dumps(payload.user_profile, indent=2)

    # ── Build system instruction + user prompt ────────────────
    system_instruction = """\
You are a world-class ATS (Applicant Tracking System) data-mapper.
Your ONLY job is to analyse a list of web form fields and a candidate's
EuroProfile, then return a precise JSON dictionary mapping each relevant
field to the correct value from the profile.

RULES — follow without exception:
1. Output ONLY a flat JSON object. No markdown, no explanation, no extra keys.
2. Keys MUST be the field's `id` if present, otherwise its `name`.
3. Values MUST be plain strings taken verbatim from the profile.
   - For <select> fields, use the most likely matching option value (e.g. country code or full name).
   - For phone fields, use the phone_with_country_code value.
   - For URL fields, use the appropriate url from the profile.
4. If no profile value can confidently be mapped to a field, OMIT that key entirely.
5. NEVER invent or hallucinate values. NEVER include honeypot/hidden fields.
6. Prefer specificity: match against all of id, name, type, placeholder, and label."""

    user_prompt = f"""FORM FIELDS (scraped from the web page):
```json
{fields_json}
```

CANDIDATE EURO-PROFILE:
```json
{profile_json}
```

Return the field→value mapping JSON object now."""

    # ── Call Gemini 2.5 Flash ─────────────────────────────────
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=GEMINI_API_KEY)

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                temperature=0.0,   # fully deterministic — we want consistent mappings
            ),
        )

    except Exception as exc:
        logger.error("Gemini API call failed in map-fields: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Gemini API error: {exc}")

    # ── Parse the raw JSON dict from Gemini's response ────────
    try:
        raw_mapping: Dict[str, Any] = json.loads(response.text)

        # Coerce all values to strings; filter out None / non-scalar values
        mapping: Dict[str, str] = {
            k: str(v)
            for k, v in raw_mapping.items()
            if v is not None and isinstance(v, (str, int, float, bool))
        }

    except (json.JSONDecodeError, AttributeError) as exc:
        logger.error(
            "Failed to parse Gemini map-fields response: %s | Raw: %s",
            exc, getattr(response, 'text', '<no text>'),
        )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini returned an unparseable response: {exc}",
        )

    logger.info(
        "map-fields: Gemini resolved %d field mapping(s).",
        len(mapping),
    )

    return FieldMappingResponse(mapping=mapping)
