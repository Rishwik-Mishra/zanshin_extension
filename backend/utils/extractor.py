# ============================================================
#  Zanshin Backend — utils/extractor.py
#  Ported from: PlaceBuddy/backend/app/services/resume_service.py
#
#  Async wrapper around the existing PyMuPDF + pytesseract
#  extraction pipeline.  Operates 100% in memory — no disk I/O.
#  GDPR Art. 25 compliant (privacy-by-design, data minimisation).
# ============================================================

import asyncio
import io
import logging

logger = logging.getLogger(__name__)

# ── OCR optional dependency ──────────────────────────────────
_OCR_AVAILABLE: bool = False
try:
    import pytesseract
    from PIL import Image
    _OCR_AVAILABLE = True
    logger.info("[Extractor] pytesseract + Pillow loaded — OCR fallback ENABLED")
except ImportError:
    logger.warning(
        "[Extractor] pytesseract or Pillow not installed — OCR fallback DISABLED. "
        "Scanned image PDFs will return empty text. "
        "Install with: pip install pytesseract Pillow"
    )

# ── PyMuPDF ──────────────────────────────────────────────────
try:
    import fitz  # PyMuPDF
except ImportError as exc:
    raise ImportError(
        "PyMuPDF is required. Install with: pip install PyMuPDF"
    ) from exc


# ── Private: native PDF text extraction ──────────────────────

def _extract_pdf_native(file_bytes: bytes) -> str:
    """
    Extract text from PDF bytes using PyMuPDF (fitz).
    Operates fully in memory via stream parameter — no temp files.
    Returns empty string on any error so callers can decide to fallback.
    """
    text = ""
    try:
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for page in doc:
                text += page.get_text()
        logger.debug("[Extractor] PyMuPDF: extracted %d characters", len(text))
    except Exception as exc:
        logger.error("[Extractor] PyMuPDF extraction failed: %s", exc)
    return text


# ── Private: OCR fallback for scanned/image PDFs ─────────────

def _extract_pdf_ocr(file_bytes: bytes) -> str:
    """
    OCR fallback: render each PDF page to a high-res pixmap (300 DPI)
    via PyMuPDF, convert to PIL Image in memory, then run pytesseract.
    Gracefully returns empty string if OCR dependencies are absent.
    """
    if not _OCR_AVAILABLE:
        logger.warning("[Extractor] OCR requested but dependencies unavailable — skipping")
        return ""

    extracted_pages: list[str] = []
    try:
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for page_num, page in enumerate(doc):
                # 300 DPI scaling matrix for high-fidelity OCR
                mat = fitz.Matrix(300 / 72, 300 / 72)
                pix = page.get_pixmap(matrix=mat)

                # Convert pixmap bytes → PIL Image (all in memory)
                img = Image.open(io.BytesIO(pix.tobytes("png")))

                page_text: str = pytesseract.image_to_string(img)
                extracted_pages.append(page_text)
                logger.debug(
                    "[Extractor] OCR page %d/%d — %d chars",
                    page_num + 1, len(doc), len(page_text),
                )

        full_text = "\n".join(extracted_pages)
        logger.info(
            "[Extractor] OCR complete — %d chars across %d pages",
            len(full_text), len(extracted_pages),
        )
        return full_text

    except Exception as exc:
        logger.error(
            "[Extractor] OCR failed: %s — ensure Tesseract binary is installed", exc
        )
        return ""


# ── Public async API ──────────────────────────────────────────

async def process_pdf_bytes(file_bytes: bytes) -> str:
    """
    Async entry point for PDF text extraction.

    Strategy (in order):
        1. Native text layer via PyMuPDF (fast, zero-loss for digital PDFs).
        2. OCR via pytesseract if the native layer returns empty text
           (handles scanned image PDFs).

    All processing is done in memory — no files are written to disk at
    any point, satisfying GDPR Art. 25 (privacy-by-design).

    Args:
        file_bytes: Raw bytes of the uploaded PDF.

    Returns:
        Extracted plaintext string.  May be empty if extraction fails.
    """
    if not file_bytes:
        logger.warning("[Extractor] Received empty file_bytes — returning empty string")
        return ""

    # Run the blocking I/O in a thread pool to keep the async event loop free
    loop = asyncio.get_running_loop()

    text: str = await loop.run_in_executor(None, _extract_pdf_native, file_bytes)

    if not text.strip():
        logger.info("[Extractor] Native PDF layer empty — attempting OCR fallback")
        text = await loop.run_in_executor(None, _extract_pdf_ocr, file_bytes)

    if not text.strip():
        logger.warning("[Extractor] All extraction methods returned empty text")

    return text
