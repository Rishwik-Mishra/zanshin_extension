"""
main_gemini_archive.py — Zanshin Extension Backend  (ARCHIVED — Phase 2.2 / 3.1)
==================================================================================
⚠️  TOKEN ECONOMICS PIVOT — DEMO FREEZE
   This file archives the live Gemini LLM parsing infrastructure that was
   active in main.py up to Phase 3.1.  The code below is PRESERVED INTACT
   and should be moved back into main.py when we re-enable cloud parsing.

Original Phase 2.2 / 3.1 flow:
  1. Accepts a PDF resume upload.
  2. Extracts text in memory (GDPR Art. 25 compliant).
  3. Sends the text to Gemini 2.5 Flash with structured-output enforced
     against the EuroProfile Pydantic schema.
  4. Returns the parsed EuroProfile as JSON to the Chrome extension.
  5. [Phase 3.1] Accepts scraped form fields + a user profile, maps them
     with Gemini acting as an ATS data-mapper, returns a field→value dict.

To restore:
  • Copy the `parse_resume` endpoint (lines below) back into main.py.
  • Remove the dummy stub that currently occupies `/api/parse-resume`.
  • Ensure GEMINI_API_KEY is set in .env.
  • Re-enable `from utils.extractor import process_pdf_bytes`.
"""

# ── NOTE ─────────────────────────────────────────────────────────────────────
#  The imports below are listed for reference only. They already exist in
#  main.py (or can be restored alongside this endpoint).
# ─────────────────────────────────────────────────────────────────────────────

# import json
# import logging
# import os
# from dotenv import load_dotenv
# from fastapi import FastAPI, File, HTTPException, UploadFile
# from google import genai
# from google.genai import types
# from utils.extractor import process_pdf_bytes

# ============================================================
#  ARCHIVED: POST /api/parse-resume
#  (Gemini 2.5 Flash → 2.0 Flash fallback, structured output)
# ============================================================

# @app.post(
#     "/api/parse-resume",
#     response_model=EuroProfile,
#     tags=["Resume Parsing"],
#     summary="Parse a PDF resume into a structured EuroProfile",
# )
# async def parse_resume(
#     file: UploadFile = File(..., description="PDF resume file to parse."),
# ) -> EuroProfile:
#     """
#     **Phase 2.1 — Gemini-powered structured extraction.**
#
#     Flow:
#     1. Read the uploaded file entirely into memory (no disk writes).
#     2. Extract plaintext using PyMuPDF (+ pytesseract OCR fallback for scanned PDFs).
#     3. Send the text to Gemini 2.5 Flash with `EuroProfile` as the response schema.
#     4. Return the validated `EuroProfile` object as JSON.
#
#     All processing is in-memory. Nothing is persisted server-side.
#     GDPR Art. 25 compliant.
#     """
#
#     # ── Guard: API key must be configured ────────────────────
#     if not GEMINI_API_KEY:
#         logger.error("GEMINI_API_KEY not set — aborting parse request")
#         raise HTTPException(
#             status_code=503,
#             detail=(
#                 "Gemini API key is not configured. "
#                 "Set GEMINI_API_KEY in your .env file and restart the server."
#             ),
#         )
#
#     # ── Guard: only accept PDFs ───────────────────────────────
#     if file.content_type not in ("application/pdf", "application/octet-stream"):
#         # Also allow octet-stream in case browser doesn't set correct MIME
#         if not (file.filename or "").lower().endswith(".pdf"):
#             raise HTTPException(
#                 status_code=400,
#                 detail="Only PDF files are supported. Please upload a .pdf file.",
#             )
#
#     # ── Step 1: Read file into memory ─────────────────────────
#     try:
#         file_bytes: bytes = await file.read()
#     except Exception as exc:
#         logger.error("Failed to read uploaded file: %s", exc)
#         raise HTTPException(status_code=400, detail=f"Could not read uploaded file: {exc}")
#
#     if not file_bytes:
#         raise HTTPException(status_code=400, detail="Uploaded file is empty.")
#
#     logger.info(
#         "Received resume upload: '%s' (%d bytes)",
#         file.filename, len(file_bytes),
#     )
#
#     # ── Step 2: Extract text from PDF (in memory) ─────────────
#     try:
#         extracted_text: str = await process_pdf_bytes(file_bytes)
#     except Exception as exc:
#         logger.error("PDF text extraction failed: %s", exc)
#         raise HTTPException(
#             status_code=422,
#             detail=f"Failed to extract text from the PDF: {exc}",
#         )
#
#     if not extracted_text.strip():
#         raise HTTPException(
#             status_code=422,
#             detail=(
#                 "Could not extract any text from the uploaded PDF. "
#                 "The file may be password-protected or corrupted."
#             ),
#         )
#
#     logger.info("Extracted %d characters from resume", len(extracted_text))
#
#     # ── Step 3: Call Gemini 2.5 Flash with structured output ──
#     try:
#         from google import genai
#         from google.genai import types
#
#         client = genai.Client(api_key=GEMINI_API_KEY)
#
#         prompt = f"""You are an expert European resume parser. Extract all relevant information
# from the following resume text and return it in the structured format requested.
#
# For visa_status_by_country, infer based on nationality and any visa mentions in the resume.
# For cefr_languages, use CEFR levels (A1/A2/B1/B2/C1/C2/Native).
# For current_notice_period_days, convert notice period to days (e.g., 1 month = 30 days).
# For total_years_experience, calculate based on employment history dates.
# If a field cannot be determined from the resume, return null for optional fields.
#
# CRITICAL LINK INSTRUCTION: At the bottom of the text, you will find an \
# 'EXTRACTED HYPERLINKS' section. Analyze these raw URLs and map them to \
# `linkedin_url`, `github_url`, or `portfolio_url` based on their domains, \
# even if there is no surrounding context text.
#
# RESUME TEXT:
# ---
# {extracted_text}
# ---"""
#
#         # ── Shared call parameters ────────────────────────────
#         _call_kwargs = dict(
#             contents=prompt,
#             config=types.GenerateContentConfig(
#                 response_mime_type="application/json",
#                 response_schema=EuroProfile,
#                 temperature=0.1,   # Low temperature for deterministic extraction
#             ),
#         )
#
#         # ── Primary model: gemini-2.5-flash ──────────────────
#         try:
#             response = client.models.generate_content(
#                 model="gemini-2.5-flash",
#                 **_call_kwargs,
#             )
#         except Exception as primary_exc:
#             logger.warning(
#                 "Primary model (gemini-2.5-flash) failed — falling back to "
#                 "gemini-2.0-flash. Primary error: %s",
#                 primary_exc,
#             )
#             # ── Fallback model: gemini-2.0-flash ───────────
#             try:
#                 response = client.models.generate_content(
#                     model="gemini-2.0-flash",
#                     **_call_kwargs,
#                 )
#             except Exception as fallback_exc:
#                 logger.error(
#                     "Fallback model (gemini-2.0-flash) also failed: %s",
#                     fallback_exc,
#                     exc_info=True,
#                 )
#                 raise HTTPException(
#                     status_code=502,
#                     detail=f"Gemini API error (both models failed): {fallback_exc}",
#                 )
#
#         # Parse the structured response into our Pydantic model
#         euro_profile = EuroProfile.model_validate_json(response.text)
#
#     except HTTPException:
#         raise   # Re-raise HTTPExceptions from the fallback block unchanged
#     except Exception as exc:
#         logger.error("Gemini API call failed: %s", exc, exc_info=True)
#         raise HTTPException(
#             status_code=502,
#             detail=f"Gemini API error: {exc}",
#         )
#
#     logger.info(
#         "Successfully parsed EuroProfile for: %s %s",
#         euro_profile.legal_first_name,
#         euro_profile.legal_last_name,
#     )
#
#     # ── Step 4: Return parsed profile ────────────────────────
#     return euro_profile
