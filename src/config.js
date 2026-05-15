import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  dbSsl: String(process.env.DB_SSL || "false").toLowerCase() === "true",
  tesseractPath: process.env.TESSERACT_PATH || "tesseract"
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required. Copy api/.env.example to api/.env first.");
}
