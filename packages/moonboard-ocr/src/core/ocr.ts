import Tesseract from 'tesseract.js';

type TesseractScheduler = {
  addJob: (action: 'recognize', image: Buffer | Blob) => Promise<{ data: { text: string } }>;
};

export type OcrOptions = {
  /** Reuse a pre-warmed Tesseract scheduler instead of spawning a fresh worker per call. */
  scheduler?: TesseractScheduler;
};

export type OcrResult = {
  name: string;
  setter: string;
  angle: number;
  userGrade: string;
  setterGrade: string;
  isBenchmark: boolean;
  warnings: string[];
};

/**
 * Convert ImageData to a PNG Blob for better Tesseract.js compatibility in browsers.
 */
async function imageDataToBlob(imageData: ImageData): Promise<Blob> {
  // Check if we're in a browser environment with OffscreenCanvas support
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  // Fallback to regular canvas if OffscreenCanvas not available
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    ctx.putImageData(imageData, 0, 0);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to convert canvas to blob'));
      }, 'image/png');
    });
  }

  throw new Error('No canvas implementation available');
}

/**
 * Run OCR on image data and parse the result.
 * Accepts Buffer (Node) or ImageData (Browser).
 */
export async function runOCR(imageData: Buffer | ImageData, options: OcrOptions = {}): Promise<OcrResult> {
  // Convert ImageData to Blob for browser compatibility
  let ocrInput: Buffer | Blob = imageData as Buffer;
  // Guard against ImageData not being defined in Node.js environment
  if (typeof ImageData !== 'undefined' && imageData instanceof ImageData) {
    ocrInput = await imageDataToBlob(imageData);
  }

  const result = options.scheduler
    ? await options.scheduler.addJob('recognize', ocrInput)
    : await Tesseract.recognize(ocrInput, 'eng');
  const text = result.data.text;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return parseHeaderText(lines);
}

/**
 * Parse the OCR'd text lines into structured data
 *
 * Expected format:
 * Line 1: "CLIMB NAME ♡" or "CLIMB NAME"
 * Line 2: "Set by [setter] @ [angle]°"
 * Line 3: "Grade: User [grade]/ Setter [grade]"
 */
export function parseHeaderText(lines: string[]): OcrResult {
  const warnings: string[] = [];
  let name = '';
  let setter = '';
  let angle = 40; // Default angle
  let userGrade = '';
  let setterGrade = '';
  let isBenchmark = false;

  // Check for benchmark indicator (orange "B" appears as standalone "B" or "8" in OCR)
  // It's typically on a line by itself near the climb name
  for (const line of lines) {
    const trimmed = line.trim();
    // Look for standalone "B" or "8" (OCR might read orange B as 8)
    if (trimmed === 'B' || trimmed === '8' || trimmed === '[B]' || trimmed === '(B)') {
      isBenchmark = true;
      break;
    }
  }

  // Try to find climb name (usually first meaningful line)
  // Collect candidate lines and pick the best one
  const nameCandidates: string[] = [];
  const setterLineIndex = lines.findIndex((line) => /set\s+by\s+/i.test(line));
  // Rating stars and repeat counts below the setter can resemble long uppercase
  // names. Only the title area is eligible when the metadata boundary is known.
  const titleLines = setterLineIndex >= 0 ? lines.slice(0, setterLineIndex) : lines;

  for (const line of titleLines) {
    // Skip lines that look like metadata
    if (
      line.toLowerCase().includes('set by') ||
      line.toLowerCase().includes('grade:') ||
      line.toLowerCase().includes('any marked') ||
      line.toLowerCase().includes('user') ||
      line.toLowerCase().includes('setter')
    ) {
      continue;
    }
    // Skip very short lines (likely OCR noise)
    if (line.length < 3) {
      continue;
    }
    // Remove heart emoji and OCR artifacts, trim
    const cleaned = line
      .replace(/♡|❤️|🤍|©|®/gu, '') // Remove heart, copyright symbols
      .replace(/\s+[QO@()&]+\s*$/i, '') // A separate icon token, never letters within a real name
      .replace(/^\d+[)\]]\s*/, '') // Remove leading numbers like "0)"
      .replace(/^[yl]\s+/i, '') // Remove leading y/l (OCR artifacts)
      .trim();

    // Skip lines that are mostly garbage characters (underscores, dashes, equals)
    const alphaNumeric = cleaned.replace(/[^a-zA-Z0-9]/g, '');
    if (alphaNumeric.length < 3) {
      continue;
    }

    if (cleaned.length >= 3) {
      nameCandidates.push(cleaned);
    }
  }

  // Pick the best candidate (prefer longer names, all-caps is common for climb names)
  if (nameCandidates.length > 0) {
    // Sort by: prefer all-caps, then by length
    if (setterLineIndex >= 0)
      nameCandidates.sort((a, b) => {
        const aAllCaps = a === a.toUpperCase();
        const bAllCaps = b === b.toUpperCase();
        if (aAllCaps && !bAllCaps) return -1;
        if (!aAllCaps && bAllCaps) return 1;
        return b.length - a.length; // Longer names first
      });
    name = nameCandidates[0];

    // Clean up trailing "8" or "B" which may come from heart icon or benchmark indicator
    // We can't reliably distinguish them via OCR, so just remove the trailing chars
    // Benchmark detection relies on standalone "B" or "8" lines (checked earlier)
    name = name.replace(/\s+[[(]?[8B]\]?$/i, '').trim();
  }

  // Find setter and angle
  for (const line of lines) {
    const setterMatch = line.match(/set\s+by\s+(.+?)\s*@\s*(\d+)/i);
    if (setterMatch) {
      setter = setterMatch[1].trim();
      angle = parseInt(setterMatch[2], 10);
      break;
    }
    // Alternative format without @
    const setterOnlyMatch = line.match(/set\s+by\s+(.+)/i);
    if (setterOnlyMatch && !setter) {
      setter = setterOnlyMatch[1].trim();
    }
  }

  // Explicit labels take precedence. A setter-only grade is not a community
  // grade, and a missing setter grade must not be filled from the community.
  const gradeLines = setterLineIndex >= 0 ? lines.slice(setterLineIndex + 1) : lines;
  const hasGradeLabels = gradeLines.some((line) => /\b(?:user|setter)\b/i.test(line));
  for (const line of gradeLines) {
    // Compressed Android plus signs can acquire a preceding dash. Only repair
    // this observed Font/V-grade form; never silently accept a malformed prefix.
    const normalized = line.replace(/([3-9][ABC])-\+(?=\/V\d+\b)/gi, '$1+');
    if (normalized !== line) warnings.push('Normalized OCR dash before grade plus');
    // A slash after the V grade can separate the legacy iOS Setter field.
    for (const match of normalized.matchAll(
      /\b(user|setter)\s+([3-9][ABC]?\+?(?:\/V\d+)?)(?![A-Z0-9+-]|\/(?!\s*(?:Setter\b|$)))/gi,
    )) {
      if (match[1].toLowerCase() === 'user' && !userGrade) userGrade = match[2];
      if (match[1].toLowerCase() === 'setter' && !setterGrade) setterGrade = match[2];
    }
  }
  // Preserve the legacy unlabelled grade-order fallback only when neither label
  // survived OCR. Never let it overwrite or infer an explicitly labelled role.
  for (const line of hasGradeLabels ? [] : gradeLines) {
    const simpleGradeMatch = line.match(/(\d[ABC]?\+?\/V\d+)/gi);
    if (simpleGradeMatch && simpleGradeMatch.length >= 1) {
      if (!userGrade) userGrade = simpleGradeMatch[0];
      if (!setterGrade && simpleGradeMatch.length >= 2) {
        setterGrade = simpleGradeMatch[1];
      }
    }
  }

  // Add warnings for missing data
  if (!name) warnings.push('Could not extract climb name');
  if (!setter) warnings.push('Could not extract setter name');
  if (!userGrade) warnings.push('Could not extract user grade');
  if (!setterGrade) warnings.push('Could not extract setter grade');

  return {
    name: name || 'Unknown',
    setter: setter || 'Unknown',
    angle,
    userGrade: userGrade || 'Unknown',
    setterGrade: setterGrade || 'Unknown',
    isBenchmark,
    warnings,
  };
}
