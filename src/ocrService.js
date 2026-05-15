import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export async function readImageText(imagePath) {
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

  return stdout.trim();
}
