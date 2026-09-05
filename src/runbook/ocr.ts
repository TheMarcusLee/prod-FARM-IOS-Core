import type { Recognize } from '../drivers/verify.js';

/**
 * The OCR fallback for text targets, loaded lazily so importing the plugin never pulls in the
 * native OCR binding — tests replay with a fake driver and never reach this.
 */
export const recognizeOnDevice: Recognize = async (png) => {
    const { recognizeWords } = await import('../tiktok/ocr.js');
    return (await recognizeWords(png)).map((word) => ({
        text: word.text,
        bounds: { left: word.x, top: word.y, right: word.x + word.width, bottom: word.y + word.height },
    }));
};
