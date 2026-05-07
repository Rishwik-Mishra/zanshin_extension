"""
main.py — Zanshin Extension Backend  (Phase 2.1)
=================================================
Lightweight FastAPI proxy that:
  1. Accepts a PDF resume upload.
  2. Extracts text from it in memory (GDPR Art. 25 compliant).
  3. Sends the text to Gemini 2.5 Flash with structured-output enforced
     against the EuroProfile Pydantic schema.
  4. Returns the parsed EuroProfile as JSON to the Chrome extension.

Run locally:
    uvicorn main:app --reload --port 8000
"""

import logging
import os
from typing import Optional

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
    version="2.1.0",
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
        "version": "2.1.0",
        "gemini_key_loaded": bool(GEMINI_API_KEY),
    }


# ============================================================
#  POST /api/parse-resume
# ============================================================

@app.post(
    "/api/parse-resume",
    response_model=EuroProfile,
    tags=["Resume Parsing"],
    summary="Parse a PDF resume into a structured EuroProfile",
)
async def parse_resume(
    file: UploadFile = File(..., description="PDF resume file to parse."),
) -> EuroProfile:
    """
    **Phase 2.1 — Gemini-powered structured extraction.**

    Flow:
    1. Read the uploaded file entirely into memory (no disk writes).
    2. Extract plaintext using PyMuPDF (+ pytesseract OCR fallback for scanned PDFs).
    3. Send the text to Gemini 2.5 Flash with `EuroProfile` as the response schema.
    4. Return the validated `EuroProfile` object as JSON.

    All processing is in-memory. Nothing is persisted server-side.
    GDPR Art. 25 compliant.
    """

    # ── Guard: API key must be configured ────────────────────
    if not GEMINI_API_KEY:
        logger.error("GEMINI_API_KEY not set — aborting parse request")
        raise HTTPException(
            status_code=503,
            detail=(
                "Gemini API key is not configured. "
                "Set GEMINI_API_KEY in your .env file and restart the server."
            ),
        )

    # ── Guard: only accept PDFs ───────────────────────────────
    if file.content_type not in ("application/pdf", "application/octet-stream"):
        # Also allow octet-stream in case browser doesn't set correct MIME
        if not (file.filename or "").lower().endswith(".pdf"):
            raise HTTPException(
                status_code=400,
                detail="Only PDF files are supported. Please upload a .pdf file.",
            )

    # ── Step 1: Read file into memory ─────────────────────────
    try:
        file_bytes: bytes = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail=f"Could not read uploaded file: {exc}")

    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    logger.info(
        "Received resume upload: '%s' (%d bytes)",
        file.filename, len(file_bytes),
    )

    # ── Step 2: Extract text from PDF (in memory) ─────────────
    try:
        extracted_text: str = await process_pdf_bytes(file_bytes)
    except Exception as exc:
        logger.error("PDF text extraction failed: %s", exc)
        raise HTTPException(
            status_code=422,
            detail=f"Failed to extract text from the PDF: {exc}",
        )

    if not extracted_text.strip():
        raise HTTPException(
            status_code=422,
            detail=(
                "Could not extract any text from the uploaded PDF. "
                "The file may be password-protected or corrupted."
            ),
        )

    logger.info("Extracted %d characters from resume", len(extracted_text))

    # ── Step 3: Call Gemini 2.5 Flash with structured output ──
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=GEMINI_API_KEY)

        prompt = f"""You are an expert European resume parser. Extract all relevant information
from the following resume text and return it in the structured format requested.

For visa_status_by_country, infer based on nationality and any visa mentions in the resume.
For cefr_languages, use CEFR levels (A1/A2/B1/B2/C1/C2/Native).
For current_notice_period_days, convert notice period to days (e.g., 1 month = 30 days).
For total_years_experience, calculate based on employment history dates.
If a field cannot be determined from the resume, return null for optional fields.

RESUME TEXT:
---
{extracted_text}
---"""

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=EuroProfile,
                temperature=0.1,   # Low temperature for deterministic extraction
            ),
        )

        # Parse the structured response into our Pydantic model
        euro_profile = EuroProfile.model_validate_json(response.text)

    except Exception as exc:
        logger.error("Gemini API call failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API error: {exc}",
        )

    logger.info(
        "Successfully parsed EuroProfile for: %s %s",
        euro_profile.legal_first_name,
        euro_profile.legal_last_name,
    )

    # ── Step 4: Return parsed profile ────────────────────────
    return euro_profile
