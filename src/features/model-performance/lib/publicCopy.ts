// ═══════════════════════════════════════════════════
// What the Model Performance page may show:
// - model architecture / checkpoint names never reach the UI (redactModelNames)
// ═══════════════════════════════════════════════════

export const GENERIC_MODEL_NAME = 'Trained Indian-plate ANPR model';
export const GENERIC_ENGINE_NAME = 'AI ANPR engine';

/** Architecture / checkpoint / engine identifiers that must not be shown. */
const MODEL_NAME_RE = /\b(?:deim\w*|parseq\w*|raw\d+\w*|yolo\w*|ocr_v\d+\w*|lpu_on_gpu)\b(?:\s*\([^)]*\))?/gi;

/** Replace model architecture / version names in free text with generic wording. */
export function redactModelNames(text: string): string {
  if (!text) return text;
  return text
    .replace(/\b(?:deim\w*|lpu_on_gpu)\s*\+\s*(?:raw\d+\w*|parseq\w*|ocr_v\d+\w*)\b/gi, GENERIC_ENGINE_NAME)
    .replace(MODEL_NAME_RE, GENERIC_ENGINE_NAME)
    .replace(new RegExp(`${GENERIC_ENGINE_NAME}(?:\\s*[+,/]\\s*${GENERIC_ENGINE_NAME})+`, 'g'), GENERIC_ENGINE_NAME)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when text still contains a model name (used by tests). */
export function containsModelName(text: string): boolean {
  MODEL_NAME_RE.lastIndex = 0;
  const hit = MODEL_NAME_RE.test(text);
  MODEL_NAME_RE.lastIndex = 0;
  return hit;
}
