import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  dbSsl: String(process.env.DB_SSL || "false").toLowerCase() === "true",
  tesseractPath: process.env.TESSERACT_PATH || "tesseract",
  apiRequestSecret: process.env.API_REQUEST_SECRET || "",
  baileysEnabled: String(process.env.BAILEYS_ENABLED || "false").toLowerCase() === "true",
  baileysAuthDir: process.env.BAILEYS_AUTH_DIR || "baileys-auth",
  adminDashboardToken: process.env.ADMIN_DASHBOARD_TOKEN || "",
  adminUsername: process.env.ADMIN_USERNAME || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminTotpSecret: process.env.ADMIN_TOTP_SECRET || "",
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET || process.env.API_REQUEST_SECRET || ""
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required. Copy api/.env.example to api/.env first.");
}
