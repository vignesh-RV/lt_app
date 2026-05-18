import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";

const execFileAsync = promisify(execFile);

export async function readImageText(imagePath) {
  logInfo("ocr_start", { imagePath, tesseractPath: config.tesseractPath });
  try {
    const { stdout } = await execFileAsync(
      config.tesseractPath,
      [
        imagePath,
        "stdout",
        "-l",
        "eng",
        "--psm",
        "6"
      ],
      {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 5
      }
    );

    const text = stdout.trim();
    logInfo("ocr_success", { imagePath, characters: text.length });
    return text;
  } catch (error) {
    logError("ocr_failed", error, { imagePath, tesseractPath: config.tesseractPath });
    throw error;
  }
}
